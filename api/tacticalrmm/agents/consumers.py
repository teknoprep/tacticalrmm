import asyncio
import contextlib
import json
import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import (
    AsyncJsonWebsocketConsumer,
    AsyncWebsocketConsumer,
)
from django.contrib.auth.models import AnonymousUser
from django.shortcuts import get_object_or_404
from packaging import version as pyver

from agents.models import Agent, AgentHistory
from logs.models import AuditLog
from tacticalrmm.constants import (
    AGENT_DEFER,
    AgentHistoryType,
    AuditActionType,
    AuditObjType,
)
from tacticalrmm.permissions import _has_perm_on_agent

# Shared across all CommandStreamConsumer instances
active_streams = {}


class SendCMD(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]

        if isinstance(self.user, AnonymousUser):
            await self.close()

        await self.accept()

    async def receive_json(self, payload, **kwargs):
        auth = await self.has_perm(payload["agent_id"])
        if not auth:
            await self.send_json(
                {"ret": "You do not have permission to perform this action."}
            )
            return

        agent = await self.get_agent(payload["agent_id"])
        timeout = int(payload["timeout"])
        if payload["shell"] == "custom" and payload["custom_shell"]:
            shell = payload["custom_shell"]
        else:
            shell = payload["shell"]

        hist_pk = await self.get_history_id(agent, payload["cmd"])

        data = {
            "func": "rawcmd",
            "timeout": timeout,
            "payload": {
                "command": payload["cmd"],
                "shell": shell,
            },
            "id": hist_pk,
        }

        ret = await agent.nats_cmd(data, timeout=timeout + 2)
        await self.send_json({"ret": ret})

    async def disconnect(self, _):
        pass

    def _has_perm(self, perm: str) -> bool:
        if self.user.is_superuser or (
            self.user.role and getattr(self.user.role, "is_superuser")
        ):
            return True

        # make sure non-superusers with empty roles aren't permitted
        elif not self.user.role:
            return False

        return self.user.role and getattr(self.user.role, perm)

    @database_sync_to_async  # type: ignore
    def get_agent(self, agent_id: str) -> "Agent":
        return get_object_or_404(Agent.objects.defer(*AGENT_DEFER), agent_id=agent_id)

    @database_sync_to_async  # type: ignore
    def get_history_id(self, agent: "Agent", cmd: str) -> int:
        hist = AgentHistory.objects.create(
            agent=agent,
            type=AgentHistoryType.CMD_RUN,
            command=cmd,
            username=self.user.username[:50],
        )
        return hist.pk

    @database_sync_to_async  # type: ignore
    def has_perm(self, agent_id: str) -> bool:
        return self._has_perm("can_send_cmd") and _has_perm_on_agent(
            self.user, agent_id
        )


class CommandStreamConsumer(AsyncJsonWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stream_task = None
        self.stop_evt = None
        self.agent_id = None
        self.group_name = None
        self.cmd_id = None
        self.authorized = False

    async def connect(self):
        """Handle websocket connection."""
        self.user = self.scope["user"]

        if isinstance(self.user, AnonymousUser):
            await self.close()
            return

        if not self.user.is_authenticated:
            await self.close(4401)
            return

        if self.user.block_dashboard_login:
            await self.close()
            return

        self.agent_id = self.scope["url_route"]["kwargs"]["agent_id"]
        has_permission = await self.has_perm(self.agent_id)
        if not has_permission:
            await self.accept()
            await self.send_json(
                {
                    "error": "You do not have permission to perform this action.",
                    "status": 403,
                }
            )
            await self.close(code=4003)
            return

        agent = await self.get_agent(self.agent_id)
        if pyver.parse(agent.version) < pyver.parse("2.10.0"):
            await self.accept()
            await self.send_json(
                {
                    "error": "The streaming feature requires agent version 2.10.0 or higher.",
                    "status": 400,
                }
            )
            await self.close()
            return

        # Don’t create a group yet, cmd_id not known
        await self.accept()
        self.authorized = True

    async def disconnect(self, close_code):
        """Cleanup on disconnect."""
        chan = self.channel_name

        if chan in active_streams:
            cmd_streams = active_streams[chan]
            if self.cmd_id in cmd_streams:
                stop_evt, stream_task = cmd_streams.pop(self.cmd_id, (None, None))
                if stop_evt:
                    stop_evt.set()
                if stream_task and not stream_task.done():
                    with contextlib.suppress(asyncio.CancelledError):
                        await stream_task
            if not cmd_streams:
                active_streams.pop(chan)

        if self.group_name:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if not getattr(self, "authorized", False):
            await self.close(4403)
            return

        agent = await self.get_agent(self.agent_id)
        try:
            cmd = content["cmd"]
            shell = content.get("shell") or "cmd"
            custom_shell = content.get("custom_shell")
            run_as_user = bool(content.get("run_as_user", False))
            timeout = int(content.get("timeout", 30))
        except (KeyError, ValueError, TypeError):
            await self.send_json({"error": "Invalid command payload"})
            return

        shell = custom_shell if shell == "custom" and custom_shell else shell
        cmd_id = content.get("cmd_id") or uuid.uuid4().hex
        self.cmd_id = cmd_id

        # Create per-session group now that cmd_id is known
        self.group_name = f"agent_cmd_{self.agent_id}_{cmd_id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)

        await self.send_json({"cmd_id": cmd_id})
        subject_output = f"{self.agent_id}.cmdoutput.{cmd_id}"

        hist = await AgentHistory.objects.acreate(
            agent=agent,
            type=AgentHistoryType.CMD_RUN,
            command=cmd,
            username=self.user.username[:50],
        )

        await AuditLog.objects.acreate(
            username=self.user.username,
            agent=agent.hostname,
            agent_id=agent.agent_id,
            object_type=AuditObjType.AGENT,
            action=AuditActionType.EXEC_COMMAND,
            message=f"{self.user.username} issued {shell} command on {agent.hostname}.",
            after_value=cmd,
            debug_info={
                "ip": self.scope.get("client")[0] if self.scope.get("client") else ""
            },
        )

        chan = self.channel_name
        if chan not in active_streams:
            active_streams[chan] = {}

        data = {
            "func": "rawcmd",
            "timeout": timeout,
            "stream": True,
            "payload": {"command": cmd, "shell": shell, "cmd_id": cmd_id},
            "run_as_user": run_as_user,
            "id": hist.pk,
        }

        self.stop_evt = asyncio.Event()
        self.stream_task = asyncio.create_task(
            agent.nats_stream_cmd(
                data,
                timeout=timeout + 2,
                stop_evt=self.stop_evt,
                output_subject=subject_output,
                group=self.group_name,
            )
        )
        active_streams[chan][cmd_id] = (self.stop_evt, self.stream_task)

    async def stream_output(self, event):
        await self.send_json(
            {
                k: v
                for k, v in event.items()
                if k in ("output", "done", "exit_code", "cmd_id")
            }
        )

    async def has_perm(self, agent_id: str) -> bool:
        return await database_sync_to_async(self._has_perm_on_agent)(agent_id)

    async def get_agent(self, agent_id: str):
        return await Agent.objects.aget(agent_id=agent_id)

    def _has_perm(self, perm: str) -> bool:
        if self.user.is_superuser or (
            self.user.role and getattr(self.user.role, "is_superuser")
        ):
            return True
        elif not self.user.role:
            return False
        return getattr(self.user.role, perm, False)

    def _has_perm_on_agent(self, agent_id: str) -> bool:
        return self._has_perm("can_send_cmd") and _has_perm_on_agent(
            self.user, agent_id
        )


class AgentTerminalConsumer(AsyncWebsocketConsumer):
    """SSH / Telnet terminal to a device on the agent's LAN, tunneled through
    the MeshCentral relay. Output is sent to the browser as binary frames for
    xterm.js; the client sends JSON control messages for input/resize."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = None
        self.agent_id = None
        self.started = False
        self.protocol = None
        self.tunnel = None
        self.telnet = None
        self.ssh_conn = None
        self.ssh_proc = None
        self.bridge_task = None
        self.reader_task = None
        self.sock_a = None
        self.sock_b = None

    async def connect(self):
        self.user = self.scope.get("user")
        if isinstance(self.user, AnonymousUser) or not getattr(
            self.user, "is_authenticated", False
        ):
            await self.close(4401)
            return
        if self.user.block_dashboard_login:
            await self.close(4401)
            return

        self.agent_id = self.scope["url_route"]["kwargs"]["agent_id"]
        if not await self.has_perm(self.agent_id):
            await self.accept()
            await self.send(text_data=json.dumps({"action": "error", "data": "Permission denied"}))
            await self.close(4003)
            return
        await self.accept()

    async def receive(self, text_data=None, bytes_data=None):
        if text_data is None:
            return
        try:
            msg = json.loads(text_data)
        except Exception:
            return
        action = msg.get("action")

        if action == "start" and not self.started:
            self.started = True
            await self.start_session(msg.get("data", {}))
        elif action == "input":
            await self.handle_input(msg.get("data", {}).get("input", ""))
        elif action == "resize":
            await self.handle_resize(msg.get("data", {}))
        elif action == "disconnect":
            await self.close()

    async def start_session(self, data):
        from agents.term_proxy import (
            TelnetFilter,
            bridge_socket_to_tunnel,
            tcp_socketpair,
        )
        from agents.web_proxy import TunnelStream
        from core.utils import get_core_settings
        from meshctrl.utils import get_auth_token

        protocol = str(data.get("protocol", "ssh")).lower()
        address = str(data.get("address", "")).strip()
        try:
            port = int(data.get("port"))
            assert 0 < port < 65536
        except Exception:
            await self.term_error("Invalid port")
            return
        if not address:
            await self.term_error("Address is required")
            return

        self.protocol = protocol
        agent = await self.get_agent(self.agent_id)
        hex_node = await database_sync_to_async(lambda a: a.hex_mesh_node_id)(agent)
        if hex_node == "error":
            await self.term_error("Missing mesh node id")
            return

        core = await database_sync_to_async(get_core_settings)()
        auth_token = get_auth_token(core.mesh_api_superuser, core.mesh_token)

        await self.audit_session(agent, protocol, address, port)

        from agents.web_proxy import TunnelError

        try:
            self.tunnel = await TunnelStream.open(
                hex_node_id=hex_node, addr=address, port=port,
                use_tls=False, auth_token=auth_token,
            )
        except TunnelError as e:
            await self.term_error(str(e))
            return
        except Exception as e:
            await self.term_error(f"Could not reach {address}:{port} via agent ({e})")
            return

        if protocol == "telnet":
            self.telnet = TelnetFilter()
            self.reader_task = asyncio.create_task(self.telnet_reader())
            await self.send(text_data=json.dumps({"action": "connected"}))
        elif protocol == "ssh":
            await self.start_ssh(data)
        else:
            await self.term_error("protocol must be ssh or telnet")

    async def start_ssh(self, data):
        import asyncssh
        from agents.term_proxy import bridge_socket_to_tunnel, tcp_socketpair

        username = str(data.get("username", "") or "")
        password = data.get("password", "") or ""
        cols = int(data.get("cols", 80) or 80)
        rows = int(data.get("rows", 24) or 24)

        loop = asyncio.get_running_loop()
        self.sock_a, self.sock_b = tcp_socketpair()
        self.bridge_task = await bridge_socket_to_tunnel(self.tunnel, self.sock_b, loop)

        try:
            self.ssh_conn = await asyncssh.connect(
                sock=self.sock_a,
                username=username,
                password=password,
                known_hosts=None,
                login_timeout=25,
                keepalive_interval=30,
            )
        except asyncssh.PermissionDenied:
            await self.term_error("SSH authentication failed")
            return
        except Exception as e:
            await self.term_error(f"SSH connection failed: {e}")
            return

        try:
            self.ssh_proc = await self.ssh_conn.create_process(
                term_type="xterm-256color", term_size=(cols, rows),
                encoding=None, stderr=asyncssh.STDOUT,
            )
        except Exception as e:
            await self.term_error(f"Could not open shell: {e}")
            return

        self.reader_task = asyncio.create_task(self.ssh_reader())
        await self.send(text_data=json.dumps({"action": "connected"}))

    async def telnet_reader(self):
        try:
            while True:
                data = await self.tunnel.read()
                if data == b"":
                    break
                clean, reply = self.telnet.feed(data)
                if reply:
                    await self.tunnel.write(reply)
                if clean:
                    await self.send(bytes_data=clean)
        except Exception:
            pass
        finally:
            await self.send_closed()

    async def ssh_reader(self):
        try:
            while True:
                data = await self.ssh_proc.stdout.read(65536)
                if not data:
                    break
                await self.send(bytes_data=data)
        except Exception:
            pass
        finally:
            await self.send_closed()

    async def handle_input(self, data):
        if not data:
            return
        raw = data.encode("utf-8", "replace") if isinstance(data, str) else data
        try:
            if self.protocol == "telnet" and self.tunnel:
                # escape IAC in user data
                await self.tunnel.write(raw.replace(b"\xff", b"\xff\xff"))
            elif self.protocol == "ssh" and self.ssh_proc:
                self.ssh_proc.stdin.write(raw)
        except Exception:
            pass

    async def handle_resize(self, data):
        try:
            cols = int(data.get("cols", 80))
            rows = int(data.get("rows", 24))
            if self.protocol == "ssh" and self.ssh_proc:
                self.ssh_proc.change_terminal_size(cols, rows)
        except Exception:
            pass

    async def term_error(self, message):
        with contextlib.suppress(Exception):
            await self.send(text_data=json.dumps({"action": "error", "data": message}))
            await self.close(4000)

    async def send_closed(self):
        with contextlib.suppress(Exception):
            await self.send(text_data=json.dumps({"action": "closed"}))
            await self.close()

    async def disconnect(self, close_code):
        with contextlib.suppress(Exception):
            if self.reader_task:
                self.reader_task.cancel()
            if self.bridge_task:
                self.bridge_task.cancel()
            if self.ssh_proc:
                self.ssh_proc.close()
            if self.ssh_conn:
                self.ssh_conn.close()
            if self.tunnel:
                await self.tunnel.close()
            for s in (self.sock_a, self.sock_b):
                if s:
                    with contextlib.suppress(Exception):
                        s.close()

    @database_sync_to_async
    def audit_session(self, agent, protocol, address, port):
        AuditLog.audit_mesh_session(
            username=self.user.username,
            agent=agent,
            debug_info={
                "feature": "remote_terminal",
                "target": f"{protocol}://{address}:{port}",
            },
        )

    async def has_perm(self, agent_id):
        return await database_sync_to_async(self._has_perm_on_agent)(agent_id)

    async def get_agent(self, agent_id):
        return await Agent.objects.aget(agent_id=agent_id)

    def _has_perm(self, perm):
        if self.user.is_superuser or (
            self.user.role and getattr(self.user.role, "is_superuser")
        ):
            return True
        elif not self.user.role:
            return False
        return getattr(self.user.role, perm, False)

    def _has_perm_on_agent(self, agent_id):
        return self._has_perm("can_use_mesh") and _has_perm_on_agent(
            self.user, agent_id
        )

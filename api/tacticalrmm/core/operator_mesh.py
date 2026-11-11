"""Mesh Take Control facts for the Pi AI Operator.

The Operator (a Node service) opens a MeshCentral Take Control tunnel for a workstation.
It needs the mesh node id, the mesh user, the mesh key and the relay base URL. Those live in
this Django app's database and settings, so the Operator used to run a Python helper that
imported Django. The Operator container has no Python, so every desktop action failed.

This view returns the same facts over the RMM API. The Operator already authenticates to
the RMM with its X-API-KEY (the same key it uses for every other RMM call), so no new
secret is introduced.

GET /core/operator/mesh-bootstrap/<agent_id>/
  200 {"ok": true, "hostname", "agentId", "nodeId", "meshUser", "meshKeyHex", "wsBase"}
  404 {"ok": false, "error": "agent_not_found"}
  409 {"ok": false, "error": "mesh_node_missing"}
"""

from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from agents.models import Agent
from core.utils import _b64_to_hex, get_core_settings


class OperatorMeshBootstrap(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, agent_id):
        agent = (
            Agent.objects.filter(agent_id=agent_id)
            .only("agent_id", "hostname", "mesh_node_id")
            .first()
        )
        if not agent:
            return Response({"ok": False, "error": "agent_not_found"}, status=404)
        if not agent.mesh_node_id:
            return Response({"ok": False, "error": "mesh_node_missing"}, status=409)

        core = get_core_settings()
        mesh_port = getattr(settings, "MESH_PORT", 4430)
        if settings.DOCKER_BUILD:
            ws_base = settings.MESH_WS_URL
        elif getattr(settings, "USE_EXTERNAL_MESH", False):
            ws_base = (core.mesh_site or "").replace("https", "wss")
        else:
            ws_base = f"ws://127.0.0.1:{mesh_port}"

        return Response(
            {
                "ok": True,
                "hostname": agent.hostname,
                "agentId": agent.agent_id,
                "nodeId": "node//" + _b64_to_hex(agent.mesh_node_id),
                "meshUser": f"user//{core.mesh_api_superuser}",
                "meshKeyHex": core.mesh_token,
                "wsBase": ws_base.rstrip("/"),
            }
        )

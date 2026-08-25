# Remote Pi from the AI windows — drive a chat from your phone

Status: **built and live** (2026-08-25). Written after reading `remote-pi@0.7.0` against
how the bridge actually hosts sessions, then implemented as described below.

Shipped in `11a6e389` (backend + bridge) and `tacticalrmm-web@80cb0f7` (UI). Files:
`api/tacticalrmm/core/ai_remote.py`, `core/migrations/0110_ai_remote_relay.py`,
`accounts/migrations/0050_role_can_use_ai_remote.py`, `pibridge/src/remote-room.js`,
`pibridge/test/remote-room.test.mjs`.

## The ask

> A user with the right permission can use the pi extension `remote-pi` from within Pi
> Chat or the AI Decision window, so the chat can be worked from a phone. Closing the
> window or the chat closes the relay. The relay URL is set globally in the AI settings,
> pre-programmed as `https://pi.api.blueuc.com`, but **not** a default for new installs.

Verdict: **yes, this is buildable**, and the relay is already reachable
(`curl https://pi.api.blueuc.com/health` → `OK`). But *not* by dropping the extension into
the bridge — see §2. The shape that works is §3.

---

## 1. What Remote Pi actually is

Two independent layers ship in the same package:

1. **Agent network** — a local Unix-socket broker so several Pi processes on one machine
   can message each other (`list_peers`, `agent_send`). Irrelevant to us.
2. **Mobile app over a relay** — a small WebSocket server ferries typed messages between
   a phone and a Pi process. Pairing is one-time per device via a QR code. **This is the
   layer we want.**

The wire protocol is fully typed in `dist/protocol/types.d.ts`:

- Phone → Pi (`ClientMessage`): `pair_request`, `user_message` (+ one inline image),
  `cancel`, `approve_tool`, `session_sync`, `session_new`, `session_compact`, `model_set`,
  `thinking_set`, `list_models`, `extension_ui_response`.
- Pi → phone (`ServerMessage`): `pair_ok`/`pair_error`, `user_input`, `agent_chunk`,
  `agent_message`, `agent_done`, `tool_request`, `tool_result`, `error`, `cancelled`,
  `session_history`, `models_list`, `action_ok`/`action_error`, `bye`,
  `extension_ui_request`.

Transport pieces we can import directly:

| Module | Use |
|---|---|
| `dist/transport/relay_client.js` | WS + Ed25519 challenge-response auth to the relay |
| `dist/transport/peer_channel.js` | `PlainPeerChannel` — encode/route `ServerMessage`s to one paired app peer |
| `dist/pairing/crypto.js` | Ed25519 keygen/sign/verify |
| `dist/pairing/qr.js` | `QRSession` (60s rotating pairing tokens), `buildQRUri()` |
| `dist/config.js` | `resolveRelayUrl()`, `isValidRelayUrl()`, `toWebSocketUrl()` |
| `dist/rooms.js` | `roomIdFor()` — 12-char base64url room id |

**Trust boundary, stated plainly:** the relay sees routed plaintext protocol content and
metadata. `ct` is a wire container, not end-to-end encryption. That is exactly why this
feature must point at *our* relay (`pi.api.blueuc.com`) and never at the community one,
and why an operator has to opt in per deployment rather than inherit a default.

---

## 2. Why we can't just load the extension into the bridge

Tempting: `new DefaultResourceLoader({ additionalExtensionPaths: [".../remote-pi/dist/index.js"] })`
and pass it to the `createAgentSession()` calls in `server.js`. The SDK supports that
(`docs/sdk.md` → Extensions), and `remote-pi` even has a headless mode
(`REMOTE_PI_DAEMON=1` + `_headlessUi()`), so `ctx.ui.notify` wouldn't explode.

Three blockers:

1. **The extension is a module-level singleton.** `_state`, `_relay`, `_autoInited`, the
   bound `pi` session, the active peer map — all module scope, one set per Node process
   (see the `_setPiForTest` / `_getState` helpers in `index.d.ts`). The bridge hosts up to
   `MAX_SESSIONS` concurrent windows in **one** process. The second window to enable
   Remote would hijack the first one's relay binding.
2. **Identity and pairing are per-`$HOME`, not per-session.** `pairing/storage.js` reads
   `~/.pi/remote/identity.json` and `~/.pi/remote/peers.json`, and the README is explicit:
   "once a device is paired, every Pi process on this machine accepts it". On a
   multi-technician RMM that means tech A's phone could attach to tech B's window. Not
   acceptable. Isolating it would need one process per technician with its own `HOME`.
3. **It would bring the wrong tools.** The extension registers `list_peers`/`agent_send`
   into the model's tool belt and a `/remote-pi` slash command. Our AI windows have a
   deliberately curated, capability-gated tool belt; an agent-mesh tool has no business in
   a technician's device chat.

Spawning one child `pi` per relayed window (own `HOME`, own process) *would* dodge 1 and 2
and give us every app feature for free — but it means hosting the AgentSession outside the
bridge, proxying the browser socket over IPC, and ~100 MB per open window. Rejected as the
first cut; revisit if the app protocol turns out to churn.

---

## 3. The shape that works: a bridge-native relay room per window

The bridge already *is* the thing the phone wants to talk to. It owns the session, the
streaming events, the approval gates and the permissions. So we speak the app's protocol
directly, reusing Remote Pi's transport modules, and skip the extension entirely.

```
 phone (Remote Pi app)
        │  wss://pi.api.blueuc.com   (relay: room_id + Ed25519 peer auth)
        ▼
 ┌──────────────────────────────────────────────┐
 │ pi-trmm-bridge (one process, N windows)      │
 │                                              │
 │  remote-room.js  ← NEW                       │
 │    RelayClient + PlainPeerChannel per window │
 │    room_id = roomIdFor(sessionsRoot, key)    │
 │    QRSession → pairing token (60s rotation)  │
 │            ▲          │                      │
 │   ServerMessage   ClientMessage              │
 │            │          ▼                      │
 │  startChat() / startDecisionChat()           │
 │    the SAME handlers the browser WS uses:    │
 │    prompt / steer / abort / approve / deny   │
 └──────────────────────────────────────────────┘
        ▲
        │ browser WS  /pi/ws/<token>/
   Pi Chat / AI Decision window
```

One relay connection per relayed window. The relay multiplexes on `(pubkey, room_id)`, so
every window can share the bridge's single Ed25519 identity as long as each gets its own
room id — no `RoomAlreadyOpenError`, no per-process `HOME` gymnastics.

### Files

| File | Change |
|---|---|
| `src/remote-room.js` | **new** — `openRemoteRoom({ key, label, send, onClient })` → `{ pairingUri, qrAscii, close() }`. Owns the RelayClient, the QRSession, the peer channel, and our own peer store. |
| `src/server.js` | in `startChat` + `startDecisionChat`: handle `set_remote` (on/off), fan session events out to the room, map inbound `ClientMessage` onto the existing switch, and `room.close()` in `ws.on("close")`. |
| `src/config.js` | `remotePiRelayUrl` (from the session blob, not env). |
| `core/models.py` | `ai_remote_enabled` (bool, default **False**), `ai_remote_relay_url` (char, default **`""`**). |
| `accounts/models.py` | `Role.can_use_ai_remote` (bool, default False). |
| `agents/views.py`, `core/views.py`, `core/odoo_ai.py` | add `remote_allowed` + `remote_relay_url` to the session blob, next to `autocredential_allowed`. |
| `AISettings.vue` | new **Remote (mobile)** settings section. |
| `RolesForm.vue` | new checkbox in the Pi.dev / AI block. |
| `PiChat.vue` | **Remote** toggle in the toolbar + a QR dialog. |

### Session-blob fields (Django decides; the bridge never trusts the browser)

```jsonc
"remote_allowed":    is_super or role.can_use_ai_remote,   // AND core.ai_remote_enabled
"remote_relay_url":  core.ai_remote_relay_url,             // "" ⇒ feature unavailable
```

Same pattern as `autocredential_allowed`: the browser can send `set_remote` all day, the
bridge answers `remote_state:{enabled:false}` unless the minted blob permits it.

### Message mapping

| Phone `ClientMessage` | Bridge does |
|---|---|
| `pair_request` | consume the QR token, store the peer under this **technician**, reply `pair_ok` (with `harness` + `hostname`) |
| `user_message` | exactly what the browser's `prompt` does: `techSaid.push(...)`, `recovery.beginTurn()`, `session.prompt()` (or `steer` while streaming). Inline images map to the SDK's `ImageContent`. |
| `cancel` | `session.abort()` |
| `approve_tool` | resolve the matching entry in `pendingApprovals` — **the phone can approve a device action**, which is the whole point of working a ticket from a car park |
| `session_sync` | replay from `history` as `SessionHistoryEvent[]` |
| `model_set` / `list_models` | restricted to `blob.allowed_models` — identical enforcement to the browser path |
| `session_new` / `session_compact` | refuse in v1 (`action_error`). A phone must not silently discard a ticket session someone else is watching. |

Outbound: the existing `session.subscribe()` handler already builds the browser frames;
the room subscribes to the same stream and re-shapes to `agent_chunk` / `agent_message` /
`tool_request` / `tool_result` / `error`. Approval prompts become `extension_ui_request`
(`confirm`) so the phone gets a real Approve/Deny dialog.

### Lifecycle — "closing the window closes the relay"

The room is **owned by the WebSocket**, not by the process:

```js
ws.on("close", () => {
  ...
  try { room?.close("window closed"); } catch {}
});
```

`close()` sends `bye` (reason `peer_stop`), detaches the peer channel, closes the
RelayClient WS and clears the pairing token. Also fired on: the `set_remote:false` toggle,
the idle timeout (`CONFIG.idleTimeoutMs`, 30 min), session dispose, and bridge shutdown.
There is deliberately **no** background/daemon mode — no relay outlives the window that
opened it, which is what makes the audit story simple: a room existed exactly as long as a
named technician had that chat open.

Pairings survive (that's the point of pairing), the *room* does not.

### Isolation & audit

- Our own peer store (`/opt/pi-trmm-bridge/remote-peers.json`) keyed by **RMM username** —
  we do **not** use `remote-pi`'s machine-wide `peers.json`. A phone paired by tech A can
  never attach to tech B's room.
- A relayed window logs `remote room opened/closed` with username, surface, ticket/agent
  and room id, and writes an `AI_SESSION` audit row. Every action the phone takes is
  already audited by the tool layer — it goes through the same gates, so a phone cannot do
  anything the same person couldn't do in the browser.
- Read-only / Write mode / auto-approve / auto-credential are all **session** state; the
  phone inherits them and cannot raise them.

---

## 4. Global settings (Global Settings → Pi.dev AI → *Remote (mobile)*)

| Setting | Field | Default (new install) | This deployment |
|---|---|---|---|
| Enable phone access to AI windows | `ai_remote_enabled` | **off** | on (after build) |
| Relay URL | `ai_remote_relay_url` | **`""`** (empty) | `https://pi.api.blueuc.com` |

Validation mirrors the extension: `http://` or `https://` only, `ws(s)://` rejected with a
targeted message; the bridge converts to `wss://` at connect time.

Empty URL ⇒ the Remote toggle never appears, whatever the permission says. That is what
keeps this from becoming a default: a fresh install ships the field blank, so nothing can
phone home until an operator deliberately types a relay in. The value is **pre-programmed
for this box only**, by a data migration guarded on "is this the existing deployment":

```python
# core/migrations/01xx_ai_remote.py
def seed(apps, schema_editor):
    Core = apps.get_model("core", "CoreSettings")
    for c in Core.objects.all():
        # Only an EXISTING install (one that already has the AI module configured)
        # gets the URL pre-filled. A fresh install has no providers yet → stays blank.
        if apps.get_model("core", "AIProvider").objects.exists():
            c.ai_remote_relay_url = "https://pi.api.blueuc.com"
            c.save(update_fields=["ai_remote_relay_url"])
```

`AIProvider.objects.exists()` is the "this is not a fresh install" test — `install.sh` runs
migrations before anything is configured, so a new box migrates with an empty provider
table and keeps the blank default.

---

## 5. How a technician uses it

1. Admin: Global Settings → Pi.dev AI → **Remote (mobile)** → enable, relay URL is already
   `https://pi.api.blueuc.com`.
2. Admin: Accounts → Roles → the tech's role → Pi.dev AI → tick **Use AI from mobile
   (Remote Pi)**.
3. Tech installs the Remote Pi app (one-time, links in the extension README).
4. Tech opens a device chat or a Johnny 5 ticket chat as usual and works it in the
   browser.
5. Tech clicks **Remote** in the toolbar. A dialog shows a QR (rotating every 60s) and the
   pairing URI as copyable text. The toolbar chip goes `Remote: waiting…`.
6. Tech scans it with the app. Chip → `Remote: paired (iPhone)`. The phone shows the
   conversation so far (`session_sync`) and follows it live.
7. Tech walks away from the desk. On the phone they can read the stream, type follow-ups,
   attach a photo of the screen/label they're standing in front of, cancel a turn, and
   **approve or deny** device actions as they pop.
8. Back at the desk, the browser window is still the same session — nothing forked.
9. Tech closes the chat window (or toggles **Remote** off). The relay room closes, the
   phone shows `bye`. Next time they open a chat they press Remote again; the pairing is
   remembered, so it's one tap, no QR.

**What the phone cannot do:** open a *new* chat, pick a model outside the role's allowed
list, switch Write mode on, grant itself auto-approve, or keep a room alive after the
window is closed.

---

## 6. As built — what differs from the plan above

Three things changed once it met the real code:

1. **One prompt path per surface, not a parallel one.** `startChat` and
   `startDecisionChat` each grew a `runPrompt(text, images, origin)`; the browser's
   `case "prompt"` and the phone's `user_message` both call it. Splitting them would have
   applied the watchdog budget, the liveness reset and the silent LLM recovery to the
   browser only — and the surface that would have missed out is the one on a phone signal.
2. **The room is created by `makeRemoteBinding`, not by the surface.** Both surfaces now
   carry ~12 lines of wiring; everything shared (toggle, pairing, fan-out, teardown) lives
   in `remote-room.js`, which is what the tests exercise.
3. **Known devices re-attach without a QR.** A phone this technician already paired that
   turns up in a NEW room is promoted straight to a channel. Second and later use is one
   tap, which is what makes the feature usable rather than a novelty.

Verified end to end against the live relay on 2026-08-25:

```
[ready] remote_allowed = true
[remote_state] {"enabled":true,"allowed":true,"state":"waiting"}
[remote_pairing] uri = remotepi://pair?t=…&epk=…&n=PDM+—+BlueCloud&rm=9BisObX1Re9s
[ws] closing the window
→ bridge log: remote room opened … room=9BisObX1Re9s
              remote room closed … window closed
```

and the refusal path, with a blob minted for a role without the permission:

```
[ready] remote_allowed = false
[remote_state] {"enabled":false,"allowed":false,"state":"off",
                "error":"Mobile access is not enabled for your role, or no relay is configured."}
→ zero relay connections opened
```

## 7. Original build order

1. **Backend** — 2 CoreSettings fields + 1 role permission + migration (with the guarded
   seed) + blob fields + serializer/RolesForm/AISettings UI. Ship this first: it's inert
   until the bridge understands `set_remote`.
2. **`src/remote-room.js`** — RelayClient + QRSession + peer store + `ServerMessage`
   encoder. Unit-test the mapping against `protocol/types.d.ts` the way
   `test/tool-caps.test.mjs` tests the capability floor.
3. **`server.js` wiring in `startDecisionChat` first** (the ticket surface is where phone
   work actually pays), then `startChat`.
4. **`PiChat.vue`** — toggle, QR dialog, paired-device chip, the `remote_state` /
   `remote_pairing` frames.
5. Odoo panel (`odoo-chat.js`) last, if wanted.

Risk to watch: we are re-implementing an app protocol we don't own. Pin the `remote-pi`
version we read the modules from, keep the mapping in one file, and make the app's version
visible in the `pair_ok` handshake log so a protocol bump is diagnosable in one grep.

# Knowing whether a turn is alive

## The question

"Is there a way to figure out if things are actually still working in real time, instead
of having limits?"

Yes. The signal exists, is exact, and was being thrown away.

## What was happening

Both the bridge and the chat UI decided a turn was stuck by timing the gap between
*parsed agent events*:

* bridge — `turnStallMs`, abort after 180s of no events
* UI — `stalled = staleSec >= 45`, turn the status orange and offer Stop

Neither measures whether anything is actually working. They measure whether anything is
being *rendered*, which is a different thing, and a model assembling one large tool
argument renders nothing for minutes.

## What the wire actually says

Captured from `api.x.ai` during exactly such a turn (`/tmp/wire-probe2.mjs`):

```
t= 16414ms  gap=15001ms   13B  RAW=": keepalive\n\n"
t= 31416ms  gap=15002ms   13B  RAW=": keepalive\n\n"
t= 46420ms  gap=15004ms   13B  RAW=": keepalive\n\n"
...
```

The provider heartbeats **every 15.000 seconds** for the whole turn. `: keepalive` is an
SSE *comment*, and [the SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)
says parsers ignore comment lines — so pi-ai's parser correctly drops every one, no agent
event is emitted, and the watchdog sees a flat line while the connection is healthy.

Measured side by side on one real turn (`/tmp/liveness-probe.mjs`):

| measurement | value |
|---|---|
| longest gap between parsed events | **74,850 ms** |
| longest quiet period on the wire | **14,474 ms** |

The stream was never quiet for more than one heartbeat cadence. The silence was an
artifact of where we were listening.

## How it is measured now

`src/stream-liveness.js` installs one transparent pass-through wrapper on
`globalThis.fetch` (pi-ai's fallback; the coding-agent exposes no hook, and patching
`node_modules` is reverted by the next `npm install`). It counts bytes on provider
response bodies and never buffers, alters or delays them.

Concurrent chats share the process, so bytes are attributed with `AsyncLocalStorage`. The
store is captured **synchronously inside the fetch wrapper**, while still on the calling
turn's async context — reading it later from a stream callback would not be reliable.

Each turn therefore knows:

* `observed` — has any byte ever arrived (false ⇒ do not trust liveness, fall back)
* `quietMs()` — ms since the last byte, or `null` if never observed
* `bytes` / `chunks` / `elapsedMs()`

## The rules that replaced the limit

In `src/turn-watchdog.js`:

| situation | verdict |
|---|---|
| bytes arriving within `deadStreamMs` (60s) | **alive** — never aborted, however long it thinks |
| no bytes for > 60s (≈4 missed heartbeats) | **dead** — abort, and retry it (usually transient) |
| still streaming past `maxTurnMs` (20 min) | abandon — alive but never finishing is still a failure |
| liveness never observed on this turn | fall back to the old event-gap budget, kept as a net |

This is both **more correct** (a working turn is never killed) and **faster** (a dead
stream is called in ~1 minute instead of 3).

## Telling the client

While a turn is quiet the bridge now sends, every ~10s:

```json
{ "type": "working", "elapsed_ms": 172000, "quiet_ms": 41000,
  "alive": true, "last_byte_ms": 3000, "bytes": 172110, "tools_in_flight": 0 }
```

`alive` is `true` / `false` / `null` (no signal). Unknown frame types are safely ignored
by the currently deployed UI, so the server side is live already.

The matching UI change is **`docs/pichat-working-frame.patch`** — it makes the chat window
trust the measurement instead of its own 45s timer, and say
*"still working… (172s) — composing a long answer, connection confirmed alive"*.

> Not applied. `tacticalrmm-web` had uncommitted work in the tree
> (`AIProcedures.vue`, `AIReportSchedules.vue`) at the time, and rebuilding would have
> shipped someone else's unfinished changes. Verified with `git apply --check`.

## Checking it still works

Every turn logs its measurement:

```
agent_end <agent> <session> liveness observed=true bytes=172110 chunks=133 quiet=2ms elapsed=57s
```

`observed=false` appearing on a provider that should be wrapped is the early warning that
the hook has stopped working — for instance if a pi upgrade stops routing through
`globalThis.fetch`. Watch for it:

```sh
grep -c 'observed=false' /var/log/pi-trmm-bridge.log
```

## Tuning

| env var | default | meaning |
|---|---|---|
| `DEAD_STREAM_MS` | 60000 | wire silence that means the stream is dead |
| `MAX_TURN_MS` | 1200000 | absolute ceiling for one streaming turn (0 disables) |
| `WORKING_PING_MS` | 10000 | how often to tell the browser it is still alive |
| `TURN_STALL_MS` | 180000 | **fallback only** — event-gap budget when liveness is unavailable |

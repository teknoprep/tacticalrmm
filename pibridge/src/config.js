// Central config, read from environment (see /etc/pi-trmm-bridge.env)
export const CONFIG = {
  port: parseInt(process.env.PORT || "8787", 10),
  host: process.env.HOST || "127.0.0.1",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  // TRMM REST API base (the bridge calls this with a service X-API-KEY to act on devices)
  trmmApiUrl: process.env.TRMM_API_URL || "http://127.0.0.1:8080",
  trmmApiKey: process.env.TRMM_API_KEY || "",
  // where pi session .jsonl files live (per agent_id)
  sessionsRoot: process.env.PI_SESSIONS_ROOT || "/opt/pi-trmm-bridge/sessions",
  idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS || String(30 * 60 * 1000), 10),
  // Liveness is MEASURED off the provider socket (see stream-liveness.js), not inferred
  // from agent-event gaps. Providers heartbeat their SSE streams - xAI sends
  // `: keepalive` every 15s - so real wire silence this long means several missed
  // heartbeats and a genuinely dead stream. Kept well above one cadence so a slow
  // network cannot fake a death.
  deadStreamMs: parseInt(process.env.DEAD_STREAM_MS || String(60 * 1000), 10),
  // Backstop for a stream that heartbeats forever without ever finishing. Generous:
  // legitimate turns here run several minutes. 0 disables.
  maxTurnMs: parseInt(process.env.MAX_TURN_MS || String(20 * 60 * 1000), 10),
  // FALLBACK ONLY, for providers/paths where no byte was ever observed: force-abort a
  // streaming turn that emits no agent events for this long. This is the old guess, kept
  // so the safety net never vanishes if the liveness hook stops working. Set 0 to disable.
  turnStallMs: parseInt(process.env.TURN_STALL_MS || String(3 * 60 * 1000), 10),
  // How often to tell the browser the turn is still alive while nothing else is
  // happening, so a long quiet think does not look like a crash.
  workingPingMs: parseInt(process.env.WORKING_PING_MS || String(10 * 1000), 10),
  // A stall abort is a GUESS: silence means a dead stream, but it also means a model
  // that is legitimately busy. Some providers (xAI grok on the Responses API) emit a
  // large tool argument - a 20k-char HTML email body - as one silent block, which reads
  // as a stall for minutes and then arrives complete. So the first abort is treated as
  // a fault to retry (see llm-recovery.js) and the retry gets this much more leash,
  // capped, rather than the tight budget killing the same request forever.
  turnStallEscalation: parseFloat(process.env.TURN_STALL_ESCALATION || "3"),
  turnStallMaxMs: parseInt(process.env.TURN_STALL_MAX_MS || String(15 * 60 * 1000), 10),
  // How many times a watchdog-aborted turn is re-run before the technician is told.
  stallRecoveryAttempts: parseInt(process.env.STALL_RECOVERY_ATTEMPTS || "1", 10),
  // How often the turn watchdog checks for a stalled streaming turn.
  watchdogIntervalMs: parseInt(process.env.WATCHDOG_INTERVAL_MS || String(30 * 1000), 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS || "10", 10),
  sessionPrefix: "pi_session:",
};

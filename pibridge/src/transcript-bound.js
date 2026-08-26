// A reconnect must not cost megabytes.
//
// Measured on ticket 60427 (a long, tool-heavy conversation): the `ready` frame carried
// 699 messages and 2.55 MB of JSON. That is not just slow to render - it is why the chat
// "kept disconnecting". The heartbeat ping is written to the SAME socket, so it queues
// BEHIND those megabytes: on any unhurried link the client cannot reach the ping frame
// and answer it before the heartbeat gives up, the server terminates a perfectly healthy
// connection, the browser reconnects, and it ships 2.55 MB again. The failure feeds
// itself, and it gets worse the longer the technician works the ticket - which is exactly
// when they can least afford it.
//
// So the transcript is bounded by BYTES from the most recent end. Nothing is lost: the
// model's context is untouched, the on-disk record is untouched, and AI History still has
// every turn. This is display, and no one scrolls back through seven hundred messages.
const TRANSCRIPT_MAX_BYTES = Number(process.env.PI_TRANSCRIPT_MAX_BYTES || 700000);

export function boundTranscript(messages, maxBytes = TRANSCRIPT_MAX_BYTES) {
  const all = Array.isArray(messages) ? messages : [];
  if (maxBytes <= 0) return all;
  const kept = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const size = JSON.stringify(all[i]).length + 1;
    // Always keep at least one message: a single turn over budget is still the thing the
    // technician is looking at.
    if (bytes + size > maxBytes && kept.length) break;
    kept.unshift(all[i]);
    bytes += size;
  }
  if (kept.length === all.length) return all;
  // A tool result whose call was cut off renders as nothing, because the browser matches
  // it by id. Drop those rather than ship bytes that cannot be displayed.
  const callIds = new Set();
  for (const m of kept) {
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === "toolCall" && c.id) callIds.add(c.id);
    }
  }
  const trimmed = kept.filter((m) => m?.role !== "toolResult" || callIds.has(m.toolCallId));
  const dropped = all.length - trimmed.length;
  return [
    {
      role: "system",
      content: [{
        type: "text",
        text:
          `--- ${dropped} earlier message${dropped === 1 ? "" : "s"} are not shown in this window. ` +
          `The assistant still has them in context, and the full record is in AI History. ---`,
      }],
    },
    ...trimmed,
  ];
}

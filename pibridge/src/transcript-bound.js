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

// How many attached images keep their bytes when a window reconnects. A screenshot is
// ~0.5-2 MB of base64 EACH, and the transcript is re-sent in full on every refresh,
// reconnect and model switch - so a long chat with a dozen screenshots would push tens of
// megabytes down the socket to redraw thumbnails nobody is looking at. The most recent few
// stay visible; older ones become a named chip with no preview (the model's own context is
// untouched - this is the DISPLAY copy).
const TRANSCRIPT_IMAGE_KEEP = Number(process.env.PI_TRANSCRIPT_IMAGE_KEEP || 4);

export function dropOldImageData(messages, keep = TRANSCRIPT_IMAGE_KEEP) {
  const all = Array.isArray(messages) ? messages : [];
  if (!all.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === "image"))) {
    return all; // nothing to do - and no copy of a large array for nothing
  }
  // A COPY: this may be `session.messages` itself, and the display trim must never reach
  // the model's own record of the conversation.
  const outMsgs = all.slice();
  let budget = keep;
  // Walk backwards: "the most recent" is what a returning technician is looking at.
  for (let i = outMsgs.length - 1; i >= 0; i--) {
    const m = outMsgs[i];
    if (!m || !Array.isArray(m.content)) continue;
    if (!m.content.some((c) => c?.type === "image")) continue;
    outMsgs[i] = {
      ...m,
      content: m.content.map((c) => {
        if (c?.type !== "image") return c;
        if (budget > 0) { budget--; return c; }
        return { ...c, data: "" }; // chip only - the UI renders no thumbnail for empty data
      }),
    };
  }
  return outMsgs;
}

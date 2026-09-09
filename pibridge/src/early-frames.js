// Frames that arrive before anyone is listening.
//
// THE BUG THIS EXISTS FOR. Every chat surface sends `ready` as soon as it knows the
// transcript, but its frame handler is attached several steps later - after the tool belt,
// the cost meter, the remote binding and the turn watchdog are built. On a busy box that
// is a second or two, and on a cold cost hydration more. The browser enables its input box
// on `ready`, and an AI Resolve window sends its seeded diagnostic prompt the instant
// `ready` arrives, so anything sent in that window was delivered to a socket with no
// `message` listener. A WebSocket does not replay it: the prompt was gone, the window sat
// on a spinner, and nothing was logged anywhere - which is indistinguishable, from the
// technician's chair, from the AI ignoring them.
//
// Reordering the setup would work too, but only until someone adds another await before
// the handler. Buffering is the property we actually want: from the moment the socket
// exists, nothing the technician sends can be dropped on the floor.
/**
 * Start collecting frames immediately. Returns a hand-off function: pass it the real
 * handler and it swaps the buffer out, then replays what arrived - in order, and only
 * after the handler is live, so a prompt typed while the window was building cannot
 * overtake one typed after it.
 *
 * @param {{on:Function, off:Function}} ws
 * @returns {(handler:(raw:any)=>any) => void}
 */
export function bufferEarlyFrames(ws) {
  const early = [];
  const collect = (raw) => early.push(raw);
  ws.on("message", collect);
  return (handler) => {
    ws.off("message", collect);
    ws.on("message", handler);
    void (async () => {
      for (const raw of early.splice(0)) {
        // The handler reports its own errors to the browser; one bad frame must not
        // swallow the ones behind it.
        try { await handler(raw); } catch { /* handled inside */ }
      }
    })();
  };
}

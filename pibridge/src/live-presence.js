// live-presence.js
//
// Ownership and consent for shared AI sessions (Pi Chat, AI Decision).
//
// One person DRIVES a session; everyone else WATCHES it live, read-only. The rules
// below are enforced here, on the server, and the browser is only ever told the
// outcome. That distinction matters: hiding a text box is a UI courtesy, not a
// permission, and a read-only viewer who crafts their own frame must still be unable
// to type into someone else's session.
//
// Rules, as specified:
//
//   1. Empty session      -> first joiner owns it. No prompt, no consent.
//   2. Occupied session   -> joiner attaches read-only and is told who is driving.
//   3. Take-over needs    -> role.can_take_over_ai_session, OR being a superuser
//                            (superuser implies it, like can_view_ai_cost).
//   4. Owner NOT admin    -> take-over is immediate. They are notified and drop to
//                            read-only; they are not ejected, because watching what
//                            happens next in a session you were driving is the point.
//   5. Owner IS admin     -> the owner must consent, UNLESS the requester is also an
//                            admin: admins bypass each other.
//   6. No answer          -> DENIED. A consent prompt that grants itself on a timeout
//                            is not consent, it is a delay.
//   7. One at a time      -> while a request is pending, further requests are
//                            rejected immediately rather than queued. First wins.
//   8. No idle release    -> an admin may hold a window all day. Only another admin
//                            takes it from them. Deliberately no timer: a session
//                            that expires while someone is reading it is a bug from
//                            the user's point of view, not tidiness.
//
// The one concession to reality is OWNER_RECLAIM_GRACE_MS. If the owner's socket
// drops, ownership is held briefly so that a browser refresh does not hand the
// session to whoever happened to be watching. Rule 8 says an admin keeps their
// window; losing it to F5 would break that.

const CONSENT_TIMEOUT_MS = 45 * 1000;
const OWNER_RECLAIM_GRACE_MS = 90 * 1000;

function identOf(blob = {}) {
  return {
    username: String(blob.username || "").toLowerCase(),
    display: blob.user_display || blob.username || "someone",
    // A superuser is an admin. Roles carry the explicit permission; superusers get
    // it implicitly, matching how can_view_ai_cost already behaves.
    isAdmin: !!blob.is_superuser,
    canTakeOver: !!blob.is_superuser || !!blob.can_take_over_ai_session,
  };
}

function newPresence() {
  return {
    owner: null,          // { username, display, isAdmin }
    ownerSocket: null,
    reclaimTimer: null,
    members: new Map(),   // ws -> ident
    pending: null,        // { from: ident, ws, timer }
  };
}

/**
 * Attach a socket. Returns { role, owner } — role is "owner" or "viewer".
 *
 * Vacant means nobody is driving: either nobody ever was, or the previous owner
 * disconnected and their reclaim grace expired. The SAME user reclaiming during the
 * grace gets their seat straight back, which is what a refresh looks like.
 */
function join(p, ws, blob) {
  const ident = identOf(blob);
  p.members.set(ws, ident);

  const vacant = !p.owner;
  const isReclaim =
    p.owner && !p.ownerSocket && p.owner.username === ident.username;

  if (vacant || isReclaim) {
    if (p.reclaimTimer) {
      clearTimeout(p.reclaimTimer);
      p.reclaimTimer = null;
    }
    p.owner = ident;
    p.ownerSocket = ws;
    return { role: "owner", owner: p.owner, reclaimed: !!isReclaim };
  }
  return { role: "viewer", owner: p.owner };
}

function isOwner(p, ws) {
  return !!p.ownerSocket && p.ownerSocket === ws;
}

/** The authority check for every inbound message that would drive the session. */
function canDrive(p, ws) {
  return isOwner(p, ws);
}

/**
 * Ask for the driving seat.
 *
 * Returns one of:
 *   {result:"granted"}            took it immediately (rules 1, 4, 5-bypass)
 *   {result:"pending", owner}     consent requested from an admin owner
 *   {result:"denied", reason}     no permission, already pending, or already owner
 */
function requestTakeover(p, ws) {
  const ident = p.members.get(ws);
  if (!ident) return { result: "denied", reason: "not attached to this session" };

  if (isOwner(p, ws)) {
    return { result: "denied", reason: "you are already driving this session" };
  }
  if (!ident.canTakeOver) {
    return {
      result: "denied",
      reason: "you do not have permission to take over a session",
    };
  }
  // Rule 7: first wins. A second request is refused outright rather than queued, so
  // the owner is never facing a stack of prompts.
  if (p.pending) {
    return {
      result: "denied",
      reason: `${p.pending.from.display} has already asked to take over; wait for that to resolve`,
    };
  }
  // Vacant: nothing to take. Rule 1 applies.
  if (!p.owner) {
    p.owner = ident;
    p.ownerSocket = ws;
    return { result: "granted", reason: "session was not being driven" };
  }
  // Rule 5: only an admin owner is protected, and not from another admin.
  const needsConsent = p.owner.isAdmin && !ident.isAdmin;
  if (!needsConsent) {
    return grant(p, ws, ident, p.owner.isAdmin ? "admin override" : "owner is not an admin");
  }
  return { result: "pending", owner: p.owner };
}

/** Move the seat. The outgoing owner stays attached, read-only (rule 4). */
function grant(p, ws, ident, reason) {
  const previous = p.owner;
  p.owner = ident;
  p.ownerSocket = ws;
  if (p.reclaimTimer) {
    clearTimeout(p.reclaimTimer);
    p.reclaimTimer = null;
  }
  return { result: "granted", previous, reason };
}

/** Record a consent request so a later approve/deny can be matched to it. */
function markPending(p, ws, onTimeout) {
  const ident = p.members.get(ws);
  const timer = setTimeout(() => {
    if (p.pending && p.pending.ws === ws) {
      p.pending = null;
      // Rule 6: silence is refusal.
      onTimeout({ granted: false, reason: "no answer from the current driver" });
    }
  }, CONSENT_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  p.pending = { from: ident, ws, timer };
  return p.pending;
}

/**
 * The owner answers. Only the CURRENT owner may answer, so a third party cannot
 * approve a take-over of someone else's session.
 */
function respondTakeover(p, ws, approve) {
  if (!isOwner(p, ws)) {
    return { ok: false, reason: "only the current driver may answer this" };
  }
  if (!p.pending) return { ok: false, reason: "there is no pending request" };

  const req = p.pending;
  clearTimeout(req.timer);
  p.pending = null;

  if (!approve) {
    return { ok: true, granted: false, to: req.ws, from: req.from };
  }
  const ident = p.members.get(req.ws);
  if (!ident) {
    return { ok: true, granted: false, to: req.ws, from: req.from,
             reason: "the requester left before you answered" };
  }
  const g = grant(p, req.ws, ident, "consent given");
  return { ok: true, granted: true, to: req.ws, from: req.from, previous: g.previous };
}

/**
 * Detach a socket. If the owner left, ownership is HELD for a grace period so a
 * refresh does not lose the seat, then released.
 */
function leave(p, ws, onReleased) {
  const wasOwner = isOwner(p, ws);
  p.members.delete(ws);

  if (p.pending && p.pending.ws === ws) {
    clearTimeout(p.pending.timer);
    p.pending = null;
  }
  if (!wasOwner) return { wasOwner: false };

  p.ownerSocket = null;
  const held = p.owner;
  p.reclaimTimer = setTimeout(() => {
    p.reclaimTimer = null;
    if (!p.ownerSocket && p.owner && p.owner.username === held.username) {
      p.owner = null;
      if (onReleased) onReleased(held);
    }
  }, OWNER_RECLAIM_GRACE_MS);
  if (p.reclaimTimer.unref) p.reclaimTimer.unref();
  return { wasOwner: true, graceMs: OWNER_RECLAIM_GRACE_MS };
}

/** What every attached socket is told. `you` differs per socket, so build per ws. */
function presenceFrame(p, ws) {
  const me = p.members.get(ws);
  return {
    type: "presence",
    owner: p.owner
      ? { username: p.owner.username, display: p.owner.display, is_admin: p.owner.isAdmin }
      : null,
    owner_connected: !!p.ownerSocket,
    viewers: [...p.members.values()].map((v) => ({
      username: v.username, display: v.display, is_admin: v.isAdmin,
    })),
    you: me
      ? {
          role: isOwner(p, ws) ? "owner" : "viewer",
          can_take_over: !!me.canTakeOver,
          // Only meaningful for a viewer: does pressing Take Over ask, or just do it?
          needs_consent: !!(p.owner && p.owner.isAdmin && !me.isAdmin),
        }
      : null,
    pending_from: p.pending
      ? { username: p.pending.from.username, display: p.pending.from.display }
      : null,
  };
}

export {
  newPresence, identOf, join, leave, isOwner, canDrive,
  requestTakeover, markPending, respondTakeover, presenceFrame,
  CONSENT_TIMEOUT_MS, OWNER_RECLAIM_GRACE_MS,
};

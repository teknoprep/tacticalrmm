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
    // EVERYONE WHO HAS ATTACHED to this session, and how much they drove it. This is the
    // record the driver needs to hand the seat BACK to someone they took it from
    // (owner, 2026-09-27): without it, a demoted user had no route back - rule 3 needs
    // can_take_over_ai_session and rule 5 makes an admin owner's seat consent-only.
    history: new Map(),   // username -> { username, display, first, last, drives, isAdmin }
    // A standing "you may take the seat without asking", granted by the CURRENT driver.
    // Single use: it is spent when that person takes the seat, so the two of them do not
    // bounce the seat back and forth. Only usernames already in `history` can be granted.
    grants: new Map(),    // username -> { by, at, display }
  };
}

/** Record that someone has (had) access to this session. */
function noteAccess(p, ident, { drove = false } = {}) {
  if (!ident?.username) return;
  const h = p.history.get(ident.username) ||
    { username: ident.username, display: ident.display, first: Date.now(), drives: 0 };
  h.display = ident.display;
  h.last = Date.now();
  h.isAdmin = ident.isAdmin;
  if (drove) h.drives += 1;
  p.history.set(ident.username, h);
}

/** The seat, and everyone who has had access to it. Sent to every attached socket. */
function seatRoster(p) {
  const connected = new Set([...p.members.values()].map((m) => m.username));
  const people = [...p.history.values()].map((h) => ({
    username: h.username,
    display: h.display,
    is_admin: !!h.isAdmin,
    connected: connected.has(h.username),
    driving: !!p.owner && p.owner.username === h.username,
    drives: h.drives,
    last_seen: h.last,
  }));
  // A viewer who attached before this feature existed, or before a name was known.
  for (const m of p.members.values()) {
    if (!people.some((x) => x.username === m.username)) {
      people.push({ username: m.username, display: m.display, is_admin: !!m.isAdmin,
                    connected: true, driving: !!p.owner && p.owner.username === m.username,
                    drives: 0, last_seen: Date.now() });
    }
  }
  people.sort((a, b) => Number(b.driving) - Number(a.driving) || a.display.localeCompare(b.display));
  return {
    owner: p.owner ? { username: p.owner.username, display: p.owner.display } : null,
    people,
    grants: [...p.grants.entries()].map(([username, g]) => ({
      username, display: g.display, by: g.by, at: g.at,
      connected: connected.has(username),
    })),
  };
}

/**
 * Hand the driving seat to a named person (owner-only; checked again in the hub).
 * Attached right now -> they drive immediately. Not attached -> a single-use grant, so the
 * seat is theirs the moment they next attach. Only someone in `history` may be chosen.
 */
function grantSeat(p, byWs, username) {
  const by = p.members.get(byWs);
  if (!isOwner(p, byWs)) return { ok: false, reason: "only the current driver can hand over the seat" };
  const want = String(username || "").toLowerCase();
  if (!want) return { ok: false, reason: "no username given" };
  if (p.owner && p.owner.username === want) return { ok: false, reason: "they are already driving" };
  const target = [...p.members.entries()].find(([, id]) => id.username === want);
  if (target) {
    const [targetWs, ident] = target;
    noteAccess(p, ident, { drove: true });
    const g = grant(p, targetWs, ident, `seat handed over by ${by?.display || "the driver"}`);
    p.grants.delete(want);
    return { ok: true, promoted: true, username: want, display: ident.display, previous: g.previous };
  }
  const h = p.history.get(want);
  if (!h) return { ok: false, reason: "that user has never had access to this session" };
  p.grants.set(want, { by: by?.display || "the driver", at: Date.now(), display: h.display });
  return { ok: true, promoted: false, username: want, display: h.display };
}

/** Take back a grant that has not been used yet. */
function revokeSeatGrant(p, byWs, username) {
  if (!isOwner(p, byWs)) return { ok: false, reason: "only the current driver can change this" };
  const want = String(username || "").toLowerCase();
  const had = p.grants.delete(want);
  return { ok: had, username: want, reason: had ? "" : "no such grant" };
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
    noteAccess(p, ident, { drove: true });
    return { role: "owner", owner: p.owner, reclaimed: !!isReclaim };
  }

  // HANDED TO THEM: the driver gave this person the seat earlier (they were not attached).
  // The grant is spent here, so the seat does not ping-pong between them.
  const handed = p.grants.get(ident.username);
  if (handed) {
    p.grants.delete(ident.username);
    noteAccess(p, ident, { drove: true });
    const g = grant(p, ws, ident, `seat handed over by ${handed.by}`);
    noteAccess(p, ident, {});
    return { role: "owner", owner: p.owner, handedOver: true, previous: g.previous };
  }

  noteAccess(p, ident, {});
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
 * WHO MAY ANSWER AN APPROVAL PROMPT (owner, 2026-09-27). Only the technician holding the seat.
 *
 * Any attached socket used to be able to answer one, which contradicted the read-only model: a
 * viewer could not type a prompt into someone else's session, but could authorise a device
 * change, a customer email or the hand-over of a stored credential. The person at the keyboard is
 * the approver (TECH_AUTHORITY_POLICY), and the person at the keyboard is whoever drives.
 *
 * An admin who wants to approve takes the seat first: the button is right there, and for an admin
 * that is immediate unless the current driver is also an admin (rules 3-5).
 */
function mayAnswerApproval(p, ws) {
  if (isOwner(p, ws)) return { ok: true };
  return {
    ok: false,
    reason: p.owner
      ? `Only ${p.owner.display} - who is driving this session - can answer that. Ask them, or press Take over to drive it yourself.`
      : "Nobody is driving this session, so there is nothing to approve yet. Press Take over to drive it.",
  };
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
          // Your own identity, so the window can tell YOUR rows in the queue history from
          // a colleague's ("You asked" vs "Dan asked") without a second lookup.
          username: me.username,
          display: me.display,
          role: isOwner(p, ws) ? "owner" : "viewer",
          can_take_over: !!me.canTakeOver,
          // Only meaningful for a viewer: does pressing Take Over ask, or just do it?
          needs_consent: !!(p.owner && p.owner.isAdmin && !me.isAdmin),
        }
      : null,
    pending_from: p.pending
      ? { username: p.pending.from.username, display: p.pending.from.display }
      : null,
    // Who holds the seat, who is watching, and everyone who has had access - so the driver can
    // give the seat back to someone they took it from, or promote a viewer.
    roster: seatRoster(p),
  };
}

export {
  newPresence, identOf, join, leave, isOwner, canDrive,
  requestTakeover, markPending, respondTakeover, presenceFrame,
  noteAccess, seatRoster, grantSeat, revokeSeatGrant, mayAnswerApproval,
  CONSENT_TIMEOUT_MS, OWNER_RECLAIM_GRACE_MS,
};

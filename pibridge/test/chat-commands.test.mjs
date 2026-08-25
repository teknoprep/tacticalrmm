// The switches, typed. What matters here is the refusals and the honesty of the answer:
// a command is a second surface onto the toolbar, never a way around it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeChatCommands } from "../src/chat-commands.js";

function harness({ writeAllowed = true, approveAllowed = true, credAllowed = true, email = true } = {}) {
  const state = { write: false, approve: false, cred: false, email: true, label: "" };
  const cmds = makeChatCommands({
    switches: {
      write: {
        label: "Write mode", allowed: writeAllowed, denied: "Your role is read-only on devices.",
        get: () => state.write, set: (v) => { state.write = v; }, on: "Pi may apply changes.", off: "Pi can look but not touch.",
      },
      approve: {
        label: "Auto-approve", allowed: approveAllowed,
        get: () => state.approve, set: (v) => { state.approve = v; },
      },
      credentials: {
        label: "Auto-credential", allowed: credAllowed,
        get: () => state.cred, set: (v) => { state.cred = v; },
      },
      ...(email ? {
        email: {
          label: "Customer email", allowed: true,
          get: () => state.email, set: (v) => { state.email = v; },
        },
      } : {}),
    },
    label: { get: () => state.label, set: (v) => { state.label = v; } },
    info: () => ({ Model: "claude-sonnet-5" }),
  });
  const run = (text) => {
    const p = cmds.parse(text);
    return p ? cmds.run(p) : null;
  };
  return { cmds, state, run };
}

test("a switch typed on is the same change the toolbar makes", () => {
  const h = harness();
  const out = h.run("/write on");
  assert.equal(h.state.write, true);
  assert.match(out.reply, /Write mode is now ON/);
  assert.equal(out.changed, true);
});

test("a role without the permission is refused, and told the truth about the state", () => {
  const h = harness({ writeAllowed: false });
  const out = h.run("/write on");

  assert.equal(h.state.write, false, "a typed command may never grant a permission");
  assert.match(out.reply, /not available to your role/i);
  assert.match(out.reply, /stays OFF/, "the refusal has to report what IS, not what was asked");
  assert.ok(!out.changed);
});

test("every switch carries its own permission", () => {
  const h = harness({ approveAllowed: false, credAllowed: false });
  h.run("/approve on");
  h.run("/creds on");
  assert.equal(h.state.approve, false);
  assert.equal(h.state.cred, false);
  // ...and the one that IS allowed still works, so a single refusal cannot disarm the rest
  h.run("/write on");
  assert.equal(h.state.write, true);
});

test("aliases and casing are forgiven, because this gets typed on a phone", () => {
  for (const text of ["/write ON", "/W on", "/writemode Yes", "/readwrite true"]) {
    const h = harness();
    h.run(text);
    assert.equal(h.state.write, true, `${text} should switch Write mode on`);
  }
});

test("no argument toggles", () => {
  const h = harness();
  h.run("/write");
  assert.equal(h.state.write, true);
  h.run("/write");
  assert.equal(h.state.write, false);
});

test("an unreadable argument changes nothing and says how to say it", () => {
  const h = harness();
  const out = h.run("/write maybe");
  assert.equal(h.state.write, false);
  assert.match(out.reply, /on.*off/i);
});

test("a slash that is a path, not a command, goes to the model", () => {
  const h = harness();
  assert.equal(h.cmds.parse("/etc/fstab looks wrong"), null);
  assert.equal(h.cmds.parse("/var/log/syslog"), null);
  assert.equal(h.cmds.parse("what does /help mean in bash"), null, "only a LEADING slash is a command");
});

test("a switch the surface does not have is not a command there", () => {
  const device = harness({ email: false });
  assert.equal(device.cmds.parse("/email off"), null, "the device chat has no customer email");
  const ticket = harness({ email: true });
  assert.ok(ticket.cmds.parse("/email off"), "the ticket chat does");
});

test("/label names the conversation and the phone pairing", () => {
  const h = harness();
  h.run("/label   Teams   PBX  integration ");
  assert.equal(h.state.label, "Teams PBX integration", "whitespace is collapsed like the field does");
  h.run("/label");
  assert.equal(h.state.label, "", "blank clears it");
});

test("/status reports every switch, including the ones refused", () => {
  const h = harness({ credAllowed: false });
  h.state.write = true;
  const out = h.run("/status");
  assert.match(out.reply, /Write mode: ON/);
  assert.match(out.reply, /Auto-approve: OFF/);
  assert.match(out.reply, /Auto-credential: not available to your role/);
  assert.match(out.reply, /Model: claude-sonnet-5/);
});

test("/help and a bare slash list only what this window has", () => {
  const h = harness({ email: false });
  for (const text of ["/help", "/", "/?"]) {
    const out = h.run(text);
    assert.match(out.reply, /\/write \[on\|off\]/);
    assert.ok(!/\/email/.test(out.reply), `${text} must not offer customer email on a device chat`);
  }
});

test("/compact stays the compaction command's job", () => {
  const h = harness();
  const out = h.run("/compact tighten it up");
  assert.equal(out.passthrough, true, "the binding must not eat it");
});

test("the autocomplete spec tells the browser what is refused rather than hiding it", () => {
  const h = harness({ writeAllowed: false });
  const write = h.cmds.spec().find((c) => c.name === "write");
  assert.equal(write.allowed, false);
  assert.match(write.denied, /read-only/);
  const approve = h.cmds.spec().find((c) => c.name === "approve");
  assert.equal(approve.allowed, true);
  assert.equal(approve.state, "OFF", "the list shows the state so you know which way to flip it");
});

test("saying what is already true changes nothing and does not pretend otherwise", () => {
  const h = harness();
  h.state.write = true;
  const out = h.run("/write on");
  assert.match(out.reply, /already ON/);
  assert.ok(!out.changed);
});

test("a setter that refuses is reported as what IS, not what was asked", () => {
  // Belt and braces: even if a surface's setter clamps the value, the answer must match
  // reality. This is the case that would otherwise tell a technician Write mode is on.
  const cmds = makeChatCommands({
    switches: {
      write: { label: "Write mode", allowed: true, get: () => false, set: () => {} },
    },
  });
  const out = cmds.run(cmds.parse("/write on"));
  assert.match(out.reply, /could not be changed; it is OFF/);
});

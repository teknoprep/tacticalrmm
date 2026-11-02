// AI desktop control switched per computer from the chat hamburger (2026-10-19).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDesktopControl, applyDesktopToolVisibility } from "../src/desktop-control.js";

const pc = (id, enabled = false) => ({ agent_id: id, hostname: id.toUpperCase(), device_facts: {}, enabled });

test("a chat with no computer of its own keeps the RMM policy untouched", () => {
  const base = { enabled: true, machines: [pc("pinned", true)] };
  const d = makeDesktopControl(base, []);
  assert.equal(d.live, false);
  assert.equal(d.policy, base);
  assert.equal(d.set("pinned", false), false);
});

test("switching this computer on and off edits the SAME policy object in place", () => {
  const d = makeDesktopControl({ enabled: false, machines: [] }, [pc("pc-a")]);
  const policy = d.policy;
  const machines = policy.machines;
  assert.equal(policy.live, true);
  assert.equal(policy.enabled, false);
  assert.equal(d.anyOn(), false);
  assert.equal(d.set("pc-a", true), true);
  assert.equal(d.policy, policy);
  assert.equal(policy.machines, machines);              // the plugin holds this array
  assert.deepEqual(policy.machines.map((m) => m.agent_id), ["pc-a"]);
  assert.equal(policy.enabled, true);
  assert.equal(d.set("pc-a", true), false);             // already on: no change
  assert.equal(d.set("pc-a", false), true);
  assert.equal(policy.machines.length, 0);
  assert.equal(policy.enabled, false);
});

test("allowlisted computers stay; the chat's computer starts in the state the RMM reported", () => {
  const d = makeDesktopControl({ enabled: true, machines: [pc("pinned", true)] }, [pc("pc-a", true)]);
  assert.deepEqual(d.policy.machines.map((m) => m.agent_id).sort(), ["pc-a", "pinned"]);
  assert.deepEqual(d.frame(), [{ agent_id: "pc-a", hostname: "PC-A", enabled: true }]);
  assert.equal(d.isChatMachine("pc-a"), true);
  assert.equal(d.isChatMachine("pinned"), false);
});

test("a computer that is neither this chat's nor allowlisted cannot be switched on here", () => {
  const d = makeDesktopControl({ enabled: false, machines: [] }, [pc("pc-a")]);
  assert.equal(d.set("pc-z", true), false);
  assert.equal(d.anyOn(), false);
});

test("operator_* tools are shown only while something is on; other tools untouched", () => {
  let active = ["run_command_on_device", "operator_start", "operator_desktop_observe"];
  const session = { getActiveToolNames: () => active, setActiveToolsByName: (n) => { active = n; } };
  const tools = [{ name: "run_command_on_device" }, { name: "operator_start" }, { name: "operator_desktop_observe" }];
  applyDesktopToolVisibility(session, tools, false);
  assert.deepEqual(active, ["run_command_on_device"]);
  applyDesktopToolVisibility(session, tools, true);
  assert.deepEqual(active.sort(), ["operator_desktop_observe", "operator_start", "run_command_on_device"]);
});

test("this chat's computer is `preferred` and listed first, ahead of the allowlisted workstation", () => {
  // LAPTOP-AP5GGTGE, 2026-10-20: the allowlisted m365-admin-w11 came first and won the default.
  const d = makeDesktopControl({ enabled: true, machines: [pc("m365-admin", true)] }, [pc("laptop", true)]);
  assert.equal(d.policy.preferred, "laptop");
  assert.deepEqual(d.policy.machines.map((m) => m.agent_id), ["laptop", "m365-admin"]);
  d.set("laptop", false);
  d.set("laptop", true);
  assert.deepEqual(d.policy.machines.map((m) => m.agent_id), ["laptop", "m365-admin"]);
});

// AI DESKTOP CONTROL PER COMPUTER (owner, 2026-10-19).
//
// The Operator (real screen, mouse and keyboard) used to be available only on the computers in
// Global Settings' allowlist - in practice one. Now a person with the permission (role
// can_use_ai_desktop, or an admin's "desktop" grant for that device) switches it on or off for a
// computer from that computer's chat hamburger. The RMM owns the decision (it edits the same
// allowlist - tacticalrmm core/operator_machines.py) and tells the bridge through /pi/desktop,
// which calls applyDesktop() on every live chat about that computer.
//
// This module keeps ONE live operator policy per chat: the object the Operator plugin and the
// system prompt read on every call/turn. Its `machines` array is edited IN PLACE, so turning a
// computer on or off reaches the tools, the prompt and the GUI-driving guard without rebuilding
// the session. The coordinator checks the RMM itself as well, so this is never the only lock.

/**
 * @param {object|null} basePolicy   blob.operator - allowlisted computers this person may reach
 * @param {Array} chatMachines       blob.desktop_machines - THIS chat's Windows computers, each
 *                                   {agent_id, hostname, device_facts, enabled}
 */
export function makeDesktopControl(basePolicy, chatMachines = []) {
  const candidates = (Array.isArray(chatMachines) ? chatMachines : []).filter((m) => m && m.agent_id);
  // Without a computer of its own to switch, a chat keeps the policy exactly as the RMM sent it.
  const live = candidates.length > 0;
  const on = new Map();
  for (const m of basePolicy?.machines || []) if (m?.agent_id) on.set(String(m.agent_id), m);
  for (const m of candidates) if (m.enabled) on.set(String(m.agent_id), m);

  // `preferred` = THIS chat's computer. It is listed first and is what a desktop tool call with no
  // `machine` means. Without it the plugin fell back to the last machine this USER drove in any
  // chat (operator-last-machine.json) - on LAPTOP-AP5GGTGE (2026-10-20) desktop control was on
  // for the laptop, yet operator_desktop_observe silently looked at m365-admin-w11, and the AI
  // told the technician it "can only reach the Operator workstation".
  const preferred = candidates.length ? String(candidates[0].agent_id) : "";
  const policy = live
    ? { ...(basePolicy || {}), live: true, enabled: false, preferred, machines: [] }
    : (basePolicy || null);
  const sync = () => {
    if (!live) return;
    const mine = [...on.values()].filter((m) => candidates.some((c) => String(c.agent_id) === String(m.agent_id)));
    const others = [...on.values()].filter((m) => !mine.includes(m));
    policy.machines.splice(0, policy.machines.length, ...mine, ...others);
    policy.enabled = policy.machines.length > 0;
  };
  sync();

  return {
    live,
    policy,
    /** Is the Operator switched on for this computer in this chat right now? */
    isOn: (agentId) => on.has(String(agentId || "")),
    anyOn: () => on.size > 0,
    isChatMachine: (agentId) => candidates.some((m) => String(m.agent_id) === String(agentId || "")),
    /** Switch one computer. Returns true when something changed. */
    set(agentId, enabled, machine = null) {
      const id = String(agentId || "");
      if (!live || !id) return false;
      const had = on.has(id);
      if (enabled && !had) {
        const m = machine || candidates.find((c) => String(c.agent_id) === id) || basePolicy?.machines?.find((c) => String(c.agent_id) === id);
        if (!m) return false;
        on.set(id, { agent_id: id, hostname: m.hostname, device_facts: m.device_facts || null });
      } else if (!enabled && had) {
        on.delete(id);
      } else {
        return false;
      }
      sync();
      return true;
    },
    /** What the window's hamburger shows: this chat's own computers and their state. */
    frame: () => candidates.map((m) => ({ agent_id: m.agent_id, hostname: m.hostname, enabled: on.has(String(m.agent_id)) })),
  };
}

/**
 * Show the operator_* tools only while at least one computer is switched on - a chat about a
 * computer nobody has switched on carries no desktop tools and no desktop instructions.
 */
export function applyDesktopToolVisibility(session, tools, anyOn) {
  if (!session || typeof session.setActiveToolsByName !== "function") return;
  const operatorNames = (tools || []).map((t) => String(t?.name || "")).filter((n) => n.startsWith("operator_"));
  if (!operatorNames.length) return;
  const active = new Set(session.getActiveToolNames());
  for (const n of operatorNames) {
    if (anyOn) active.add(n);
    else active.delete(n);
  }
  session.setActiveToolsByName([...active]);
}

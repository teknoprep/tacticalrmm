// What did THIS run cost? One line under the final answer of every run: from the moment
// the technician's prompt went in to the moment the AI finished - the chat model plus
// everything it pulled in on the way (judge, coder, scouts, summaries of reads).
//
// Measured, not estimated: a snapshot of the conversation's cost meter when the prompt
// starts, the difference when the run ends. Specialists fold their spend into the same
// meter (parentMeter.absorb), so they are in the number.
//
// The line is saved as a custom session entry, which pi never puts in the model's context,
// so a reload shows it again and the AI never reads its own bill.

function roleLabels(group) {
  const map = new Map();   // "provider/model_id" -> { name, roles[] }
  for (const m of (group?.members || group?.roles || [])) {
    if (m.enabled === false || !m.provider || !m.model_id) continue;
    const k = `${m.provider}/${m.model_id}`;
    const e = map.get(k) || { name: m.display_name || m.model_id, roles: [] };
    e.roles.push(m.role === "orchestrator" ? "chat" : m.role);
    map.set(k, e);
  }
  return map;
}

const money = (n) => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

export function makeRunCost({ meter, groupState }) {
  let base = null;
  const snap = () => {
    const s = meter.snapshot();
    const d = s.desktop || { calls: 0, turns: 0, cost: 0 };
    // Keyed by ROLE and model: what each role actually cost this run (cost-meter.js byRole).
    const rows = (s.by_role || []);
    return {
      cost: Number(s.session_cost || 0),
      priced: s.pricing_known !== false,
      desktop_calls: Number(d.calls || 0),
      desktop_turns: Number(d.turns || 0),
      desktop_cost: Number(d.cost || 0),
      cost_by: Object.fromEntries(rows.map((r) => [`${r.role}|${r.model}`, Number(r.cost || 0)])),
      turns_by: Object.fromEntries(rows.map((r) => [`${r.role}|${r.model}`, Number(r.turns || 0)])),
    };
  };
  return {
    begin() { base = snap(); },
    /** @returns {null | {total, priced, parts:[{model,role,label,cost,turns}], text}} */
    end() {
      if (!base) return null;
      const now = snap();
      const b = base;
      base = null;
      const labels = roleLabels(groupState?.current);
      const parts = Object.keys(now.cost_by)
        .map((k) => {
          const [role, model] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
          const cost = now.cost_by[k] - (b.cost_by[k] || 0);
          const turns = now.turns_by[k] - (b.turns_by[k] || 0);
          const name = labels.get(model)?.name || model.split("/").pop();
          return { model, role, cost, turns, label: `${name} (${role}${turns > 1 ? ` \u00d7${turns}` : ""})` };
        })
        .filter((p) => p.turns > 0)
        .sort((x, y) => y.cost - x.cost);
      if (!parts.length) return null;
      const total = Math.max(0, now.cost - b.cost);
      const breakdown = parts.length > 1
        ? " \u00b7 " + parts.map((p) => `${p.label} ${money(p.cost)}`).join(" \u00b7 ")
        : ` \u00b7 ${parts[0].label}`;
      // DESKTOP WORK IN THIS RUN (owner, 2026-09-27). Its cost is not a separate line item on
      // the provider bill - it is the turns the desktop consumed - so it is reported as the
      // SUBSET of this run that driving the screen accounted for, and the cumulative figure for
      // the conversation is kept alongside it.
      const dCalls = now.desktop_calls - b.desktop_calls;
      const dCost = Math.max(0, now.desktop_cost - b.desktop_cost);
      const desktopNote = dCalls > 0
        ? ` \u00b7 \u{1F5A5}\uFE0F desktop ${dCalls} action${dCalls > 1 ? "s" : ""} ${money(dCost)}` +
          (now.desktop_cost > dCost ? ` (desktop so far ${money(now.desktop_cost)} — those turns keep being re-read)` : "")
        : "";
      const text = `\u{1F4B2} This run: ${money(total)}${breakdown}${desktopNote}` +
        (now.priced ? "" : " (some usage is unpriced, so the real figure is higher)");
      return { total: Number(total.toFixed(6)), priced: now.priced, parts, text,
               desktop: { calls: dCalls, cost: Number(dCost.toFixed(6)), session: Number(now.desktop_cost.toFixed(6)) } };
    },
  };
}

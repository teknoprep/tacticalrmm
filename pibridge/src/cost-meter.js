// Live token + spend accounting for a chat session, and detection of turns that
// ended without producing an answer.
//
// Both exist because of the 2026-08-04 incidents:
//   * session 019fcc9e: one turn pulled 1.76 MB of tool JSON, put ~609k tokens into a
//     200k context window, ended on stopReason="length" having written nothing, billed
//     $7.52 - and the operator saw NO error, because only stopReason="error" was
//     surfaced to the browser.
//   * session 019fccfd: $4.78 across 69 turns, of which $2.25 was cacheWrite and $1.73
//     cacheRead - i.e. $3.98 of cache traffic to deliver $0.61 of actual output. The
//     driver was switching models four times (grok-4.5 -> sonnet-5 -> grok-4.5 ->
//     opus-5); every switch re-caches the whole context, which is free on grok
//     (cacheWrite $0/M) and expensive on Anthropic ($2.50-$6.25/M).
//
// So a single total is not enough: the meter reports WHERE the money went (token class,
// model, cost per turn) and warns BEFORE a model switch re-caches a large context.
//
// Kept side-effect free so it can be unit-tested; server.js opens sockets on import.

export const TURN_COST_WARN = Number(process.env.PI_TURN_COST_WARN || 1.0);
export const SESSION_COST_WARN = Number(process.env.PI_SESSION_COST_WARN || 5.0);
export const CONTEXT_WARN_FRACTION = Number(process.env.PI_CONTEXT_WARN_FRACTION || 0.8);
// Warn before a model switch whose cache rewrite would cost at least this much.
export const SWITCH_COST_WARN = Number(process.env.PI_SWITCH_COST_WARN || 0.1);

const CLASSES = ["input", "output", "cacheRead", "cacheWrite"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Dollar cost of re-caching `contextTokens` into `model`'s prompt cache.
 * Returns 0 when the model charges nothing to write cache (e.g. xai/grok-4.5),
 * or null when we have no pricing and therefore must not guess.
 */
export function cacheRewriteCost(model, contextTokens) {
  const rate = model?.cost?.cacheWrite;
  if (rate === undefined || rate === null) return null;
  return (num(contextTokens) * num(rate)) / 1e6;
}

/**
 * Create a per-session cost meter.
 *
 * ACCOUNTING RULE: every dollar figure here is pi's OWN number, taken from
 * `message.usage.cost` (which carries `{input, output, cacheRead, cacheWrite, total}`).
 * We never multiply tokens by rates ourselves - pi already applies provider-specific
 * rules we would get wrong, most importantly TIERED pricing (e.g. gpt-5.6-sol doubles
 * above 272k input tokens) and variants like Anthropic's `cacheWrite1h`. A flat
 * rate multiplication silently understates those. Sum what the runtime reports.
 *
 * @param {object}   o
 * @param {function} o.send       - push a frame to the client
 * @param {boolean}  o.visible    - may THIS operator see spend? (role: can_view_ai_cost)
 * @param {function} o.log        - server-side logger (always called, regardless of visible)
 * @param {string}   o.key        - agent_id or ticket key, for log lines
 * @param {string}   o.sessionId
 * @param {number}   [o.contextWindow]
 * @param {function} [o.rateLookup] - (provider, modelId) => model.cost, used ONLY to
 *                                    FORECAST the cost of a model switch (no usage exists
 *                                    yet). Never used for recorded spend.
 * @param {function} [o.ledger]     - (entry) => void. Called once per billed turn with the
 *                                    figures pi reported, for the durable spend ledger.
 *                                    Must never throw; bookkeeping cannot break a chat.
 * @param {object}   [o.context]    - identity for ledger rows: {surface, actorUsername,
 *                                    agentId, agentHostname, client, site, ticketRef}
 */
export function makeCostMeter({
  send, visible, log, key, sessionId, contextWindow = 0, rateLookup = null,
  ledger = null, context = {},
}) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  // Dollars per token class. Only populated when we have pricing for the model;
  // `pricingKnown` stays false otherwise so the UI can show "-" instead of lying.
  const spend = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byModel = new Map();          // "provider/model_id" -> {turns, cost, cacheWrite}
  let pricingKnown = true;
  let sessionCost = 0;
  let turns = 0;
  let lastTurnCost = 0;
  let contextTokens = 0;
  let nextSessionWarn = SESSION_COST_WARN;
  let lastModelKey = null;
  let modelSwitches = 0;
  let switchSpend = 0;                // cacheWrite dollars on turns that followed a switch
  const warnings = [];

  const warn = (message, detail) => {
    warnings.push(message);
    log?.("cost_warn", key, sessionId, detail);
    if (visible) send({ type: "cost_warning", message });
  };

  const meter = {
    get sessionCost() { return sessionCost; },
    get turns() { return turns; },
    get contextTokens() { return contextTokens; },
    get warnings() { return [...warnings]; },

    snapshot() {
      return {
        type: "cost_update",
        session_cost: Number(sessionCost.toFixed(6)),
        turn_cost: Number(lastTurnCost.toFixed(6)),
        cost_per_turn: turns ? Number((sessionCost / turns).toFixed(6)) : 0,
        turns,
        tokens: { ...tokens },
        // Where the money actually went. This is the number that explains a bill.
        spend: pricingKnown
          ? Object.fromEntries(CLASSES.map((c) => [c, Number(spend[c].toFixed(6))]))
          : null,
        pricing_known: pricingKnown,
        by_model: [...byModel.entries()].map(([model, v]) => ({
          model,
          turns: v.turns,
          cost: Number(v.cost.toFixed(6)),
          cost_per_turn: v.turns ? Number((v.cost / v.turns).toFixed(6)) : 0,
        })).sort((a, b) => b.cost - a.cost),
        model_switches: modelSwitches,
        switch_spend: pricingKnown ? Number(switchSpend.toFixed(6)) : null,
        context_tokens: contextTokens,
        context_window: contextWindow || 0,
      };
    },

    /**
     * Warn before switching model: the new provider must re-cache the whole context.
     * Called from the set_model handler, BEFORE the switch is applied.
     */
    previewModelSwitch(newModel, displayName) {
      // A FORECAST, not accounting: no usage exists yet, so this is the only place we
      // touch published rates. Tiered pricing may make the real charge higher, hence
      // the deliberately approximate wording below.
      const cost = cacheRewriteCost(newModel, contextTokens);
      if (cost === null || contextTokens <= 0) return null;
      if (cost >= SWITCH_COST_WARN) {
        warn(
          `Switching to ${displayName} will re-send this conversation ` +
            `(${contextTokens.toLocaleString("en-US")} tokens) into that model's cache: ` +
            `about $${cost.toFixed(2)} before it answers anything. Starting a NEW chat on ` +
            `${displayName} avoids that cost.`,
          `switch preview ${displayName} ctx=${contextTokens} est=$${cost.toFixed(4)}`,
        );
      }
      return cost;
    },

    /**
     * Fold one finished assistant message into the running totals.
     *
     * `message_end` also fires for messages that were never billed - user turns, tool
     * results and aborted turns carry no `usage` at all. Those are NOT turns: counting
     * them inflated cost-per-turn, wrote empty ledger rows (model="", cost=0) and
     * permanently marked the session's pricing unknown, which blanked the meter's
     * per-class split. Ignore anything with no usage.
     */
    record(message) {
      const u = message?.usage;
      if (!u || typeof u !== "object") return meter.snapshot();
      const cost = num(u?.cost?.total);
      lastTurnCost = cost;
      sessionCost += cost;
      turns += 1;
      for (const c of CLASSES) tokens[c] += num(u[c]);
      tokens.reasoning += num(u.reasoning);
      // totalTokens is the size of the request just billed, i.e. how full the context
      // is right now - the number that predicts the next stopReason="length".
      if (num(u.totalTokens) > 0) contextTokens = num(u.totalTokens);

      // Per-model attribution. A session that switches models hides which one was
      // expensive; opus-5 at $0.30/turn vs grok-4.5 at $0.02/turn is invisible in a total.
      const provider = message?.provider || "";
      const modelId = message?.model || "";
      const modelKey = modelId ? `${provider}/${modelId}` : "unknown";
      const agg = byModel.get(modelKey) || { turns: 0, cost: 0, cacheWrite: 0 };
      agg.turns += 1;
      agg.cost += cost;
      agg.cacheWrite += num(u.cacheWrite);
      byModel.set(modelKey, agg);

      const switched = lastModelKey !== null && lastModelKey !== modelKey;
      if (switched) modelSwitches += 1;
      lastModelKey = modelKey;

      // Per-class spend straight from pi's own cost object - authoritative and
      // tier-aware. If a model has no pricing metadata pi reports no cost object, and
      // we flag that rather than showing a fabricated $0.00.
      const costObj = u?.cost;
      if (!costObj || typeof costObj !== "object") {
        pricingKnown = false;
      } else {
        for (const c of CLASSES) spend[c] += num(costObj[c]);
        if (switched) switchSpend += num(costObj.cacheWrite);
      }

      if (visible) send(meter.snapshot());

      if (cost >= TURN_COST_WARN) {
        warn(
          `That single turn cost $${cost.toFixed(2)} (${contextTokens.toLocaleString("en-US")} ` +
            `tokens in context). Narrow the next request - broad "check everything" prompts ` +
            `pull very large tool payloads.`,
          `turn=$${cost.toFixed(4)} session=$${sessionCost.toFixed(4)} ctx=${contextTokens}`,
        );
      }
      while (sessionCost >= nextSessionWarn) {
        warn(
          `This conversation has now cost $${sessionCost.toFixed(2)} ` +
            `($${(sessionCost / Math.max(1, turns)).toFixed(3)}/turn).`,
          `session crossed $${nextSessionWarn.toFixed(2)}`,
        );
        nextSessionWarn += SESSION_COST_WARN;
      }
      if (contextWindow > 0 && contextTokens >= contextWindow * CONTEXT_WARN_FRACTION) {
        warn(
          `Context is ${Math.round((contextTokens / contextWindow) * 100)}% full ` +
            `(${contextTokens.toLocaleString("en-US")} / ` +
            `${contextWindow.toLocaleString("en-US")} tokens). Start a new chat soon, or the ` +
            `next turn may be cut off before it can answer.`,
          `ctx ${contextTokens}/${contextWindow}`,
        );
      }
      // Durable ledger row: pi's reported figures, verbatim. Wrapped so a bookkeeping
      // failure can never surface as a chat error.
      if (ledger) {
        try {
          ledger({
            session_id: sessionId,
            turn_index: turns,
            surface: context.surface || "device_chat",
            provider,
            model_id: modelId,
            actor_username: context.actorUsername || "",
            agent_id: context.agentId || "",
            agent_hostname: context.agentHostname || "",
            client: context.client || "",
            site: context.site || "",
            ticket_ref: context.ticketRef || "",
            tokens: {
              input: num(u.input),
              output: num(u.output),
              cacheRead: num(u.cacheRead),
              cacheWrite: num(u.cacheWrite),
              reasoning: num(u.reasoning),
              total: num(u.totalTokens),
            },
            cost: costObj && typeof costObj === "object"
              ? {
                  input: num(costObj.input),
                  output: num(costObj.output),
                  cacheRead: num(costObj.cacheRead),
                  cacheWrite: num(costObj.cacheWrite),
                  total: num(costObj.total),
                }
              : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            priced: !!(costObj && typeof costObj === "object"),
            context_tokens: contextTokens,
            was_model_switch: switched,
            at: new Date().toISOString(),
          });
        } catch (e) {
          log?.("spend_ledger_error", key, sessionId, String(e?.message || e));
        }
      }

      return meter.snapshot();
    },
  };
  return meter;
}

/**
 * Explain a finished assistant message that produced NO answer, or return null when the
 * turn ended normally.
 *
 * `error` is handled separately by the caller (it carries a provider reason). `length`
 * was previously swallowed entirely - that is the "it just randomly stopped" bug.
 * Unknown stop reasons are reported rather than ignored so this class of silent failure
 * cannot reappear quietly.
 */
export function silentStopMessage(message) {
  const stop = message?.stopReason;
  if (stop === "length") {
    return (
      "The turn hit the model's CONTEXT LIMIT before it could answer, so nothing was " +
      "written. This happens when tool results are too large - e.g. several days of event " +
      "logs plus full device details in one turn. The context has been compacted " +
      "automatically: ask again, but narrower (one log type, fewer days, or a specific " +
      "service/process), and it will answer."
    );
  }
  // Operator pressed Stop - intentional, not a failure.
  if (stop === "aborted" || stop === "abort" || stop === "cancelled") return null;
  if (stop && stop !== "stop" && stop !== "toolUse" && stop !== "error") {
    return (
      `The turn ended unexpectedly (stopReason="${stop}") without producing an answer. ` +
      `Please try again; if it repeats, tell an admin to check the bridge log.`
    );
  }
  return null;
}

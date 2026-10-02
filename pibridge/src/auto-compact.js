// Auto-summarize: compact a window once its context passes a threshold - checked when the
// NEXT TASK STARTS, never after the last one finished (owner, 2026-09-26: "don't waste time on
// tickets that are done"). A window nobody prompts again is never summarized; one that is
// prompted again summarizes first, then runs the prompt on the smaller context.
//
// WHY. Every turn re-sends the whole conversation, so a long window costs more per turn
// the longer it gets (30-day data, 2026-09-26: turns over 200k tokens cost $0.21 each,
// under 50k cost $0.03). pi's own auto-compaction only fires when the window is nearly
// full (window - 16k: ~484k on grok-4.7), and it can fire mid-run. That stays as the
// overflow safety net; this is the cost control.
//
// WHERE THE THRESHOLD COMES FROM (owner, 2026-09-26), first match wins:
//   1. this window's own setting, if a technician changed it here (window-memory.js);
//   2. the chat's AGENT GROUP (Settings > AI > Agent Groups; Luna groups 200k);
//   3. the chat's MODEL (Settings > AI > Models), for chats not in a group;
//   4. 100k.
// 2 and 3 are read live, so switching group or model mid-window moves the threshold.
import * as windowMemory from "./window-memory.js";

export const AUTO_SUMMARIZE_DEFAULT = 100000;
export const AUTO_SUMMARIZE_MIN = 20000;
export const AUTO_SUMMARIZE_MAX = 1000000;
// A compaction that failed at N tokens is not retried until the chat grows this much more.
const RETRY_GROWTH = 20000;
// agent_end can be followed at once by a recovery re-run or the next queue item. Wait,
// then look again: if a turn is running, this one is skipped and the next agent_end
// re-checks.
const SETTLE_MS = 2500;

export function clampSummarizeTokens(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return AUTO_SUMMARIZE_DEFAULT;
  return Math.min(AUTO_SUMMARIZE_MAX, Math.max(AUTO_SUMMARIZE_MIN, n));
}

export function makeAutoCompact({
  scopeKey, session, costMeter, compactCmd, send, log, key,
  sessionId = () => "", isBusy = () => false,
  defaultTokens = () => AUTO_SUMMARIZE_DEFAULT,
}) {
  let enabled = windowMemory.recallSwitch(scopeKey, "auto_summarize", true);
  const remembered = windowMemory.recallValue(scopeKey, "auto_summarize_tokens", -1);
  let windowTokens = remembered > 0 ? clampSummarizeTokens(remembered) : null;
  const inherited = () => {
    try { return clampSummarizeTokens(defaultTokens() || AUTO_SUMMARIZE_DEFAULT); }
    catch { return AUTO_SUMMARIZE_DEFAULT; }
  };
  const current = () => windowTokens ?? inherited();
  let timer = null;
  let running = false;
  let failedAt = 0;

  const sid = () => (typeof sessionId === "function" ? sessionId() : sessionId) || "";
  const frame = () => ({ type: "auto_summarize_state", enabled, tokens: current(), inherited: windowTokens == null, inherited_tokens: inherited() });
  const announce = () => { try { send(frame()); } catch { /* socket gone */ } };

  async function check() {
    timer = null;
    if (!enabled || running) return false;
    if (session.isStreaming || isBusy()) return false;
    const ctx = Number(costMeter?.contextTokens || 0);
    const tokens = current();
    if (ctx < tokens) return false;
    if (failedAt && ctx < failedAt + RETRY_GROWTH) return false;
    running = true;
    log?.("auto_compact", key, sid(), `context ${ctx} >= ${tokens} (before the next task)`);
    try {
      // Summarize only, no clear (owner, 2026-09-26): the transcript stays readable in the
      // window; the model works from the summary from here on.
      const res = await compactCmd.run("", {
        reason: `auto-summarize (window threshold ${tokens} tokens)`,
        note: `Auto-summarized before this task: the window was past ${tokens.toLocaleString("en-US")} tokens.`,
      });
      failedAt = res?.ok ? 0 : ctx;
    } catch (e) {
      failedAt = ctx;
      log?.("auto_compact_error", key, sid(), String(e?.message || e).slice(0, 200));
    } finally {
      running = false;
    }
    return true;
  }

  return {
    frame,
    get enabled() { return enabled; },
    get tokens() { return current(); },
    setEnabled(v, by = "") {
      enabled = !!v;
      windowMemory.rememberSwitch(scopeKey, "auto_summarize", enabled, by);
      log?.(enabled ? "auto-summarize ON" : "auto-summarize OFF", key, sid(), `by ${by || "?"}`);
      announce();
      if (enabled) this.onTurnEnd();
    },
    setTokens(v, by = "") {
      // null / "default" / 0 = go back to the group's (or model's) threshold.
      const reset = v == null || v === "default" || Number(v) <= 0;
      windowTokens = reset ? null : clampSummarizeTokens(v);
      failedAt = 0;
      windowMemory.rememberValue(scopeKey, "auto_summarize_tokens", reset ? -1 : windowTokens, by);
      log?.("auto-summarize threshold", key, sid(), `${reset ? `default (${inherited()})` : windowTokens} by ${by || "?"}`);
      announce();
      this.onTurnEnd();
    },
    /** Called on agent_end and after settings changes. Deliberately does nothing now: a
     *  finished task is not summarized (see beforePrompt). Kept so callers need not change. */
    onTurnEnd() {},
    /** Call right before a new task's prompt is sent. Awaits the summary when one is due. */
    async beforePrompt() {
      if (timer) { clearTimeout(timer); timer = null; }
      try { return await check(); } catch { return false; }
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}

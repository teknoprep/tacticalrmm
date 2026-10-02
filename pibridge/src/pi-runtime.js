// ONE place that knows how to talk to the installed pi runtime, whichever generation
// it is. Everything else in the bridge asks for a runtime and gets the same shape back.
//
// WHY THIS EXISTS: pi 0.81 replaced `AuthStorage` + `ModelRegistry` (synchronous, passed
// separately into createAgentSession) with a single async `ModelRuntime`. The bridge had
// the old pattern hard-wired into nine call sites, so it was pinned to <= 0.80.x - an
// upgrade removed an export and every AI surface died at once. Pinning is not a fix: it
// means never taking a security or model update again. So the version difference lives
// here, and only here.
//
//   pre-0.81 : AuthStorage.create() + ModelRegistry.create(auth, modelsJson)
//              createAgentSession({ authStorage, modelRegistry, ... })
//   0.81+    : await ModelRuntime.create({ modelsPath })
//              createAgentSession({ modelRuntime, ... })
//
// Uniform surface returned by piRuntime():
//   findModel(provider, id) -> model | undefined
//   listModels()            -> [{provider, model_id, display_name, reasoning, context_window}]
//   sessionOpts             -> spread into createAgentSession()
//   loadError()             -> models.json problem, or undefined
//   generation              -> "modelruntime" | "authstorage"  (for logging/diagnostics)
import { MODELS_JSON } from "./models-catalog.js";
import { getSupportedThinkingLevels } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/models.js";

// xAI publishes reasoningEffort including "xhigh" for these. The installed pi package
// only maps it on grok-4.6; grok-4.3/4.5 have xhigh: null (stale) and grok-4.7 lives in
// models.json as a stub with no map at all, so setThinkingLevel clamps "xhigh" down to
// "high" and the setting the admin picked never reaches the API. Patch the live model
// object — do NOT write these into models.json, which would shadow the built-in definition.
const XAI_XHIGH = new Set(["grok-4.3", "grok-4.5", "grok-4.6", "grok-4.7"]);

function enableXhigh(model) {
  if (!model || model.provider !== "xai" || !XAI_XHIGH.has(model.id)) return model;
  if (!model.thinkingLevelMap) {
    model.thinkingLevelMap = {
      off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
    };
  } else if (model.thinkingLevelMap.xhigh == null) {
    model.thinkingLevelMap.xhigh = "xhigh";
  }
  return model;
}

function patchXhigh(rt) {
  for (const id of XAI_XHIGH) {
    try { enableXhigh(rt.getModel ? rt.getModel("xai", id) : rt.find("xai", id)); } catch { /* not served */ }
  }
}

// Overridable so the same code can be exercised against another installed copy
// (the update pre-flight probe does exactly this before anything is swapped in).
const PKG = process.env.PI_PKG || "@earendil-works/pi-coding-agent";

let _mod = null;
async function pi() {
  if (!_mod) _mod = await import(PKG);
  return _mod;
}

/** Which generation is installed. Cheap, no side effects. */
export async function piGeneration() {
  const m = await pi();
  if (m.ModelRuntime) return "modelruntime";
  if (m.AuthStorage) return "authstorage";
  return "unknown";
}

// A models.json-FREE view of the installed package, used to answer "does pi know this
// model natively?". Needed because the normal lookup resolves through models.json, so it
// cannot tell a real built-in definition from a stub we wrote there ourselves.
const NO_MODELS_JSON = "/nonexistent/pi-trmm-bridge-no-models.json";
// pi's refreshed catalog (pi.dev) lives next to models.json. "Known natively" includes it:
// that catalog is pi's own full definition WITH its price, not a stub we wrote. Without
// this, a model pi.dev already describes (claude-opus-5-5, 2026-09-26) kept our unpriced
// stub forever and every turn on it was booked at $0.
const MODELS_STORE = MODELS_JSON.replace(/[^/]+$/, "models-store.json");
let _builtinRt = null;
async function builtinRuntime() {
  if (_builtinRt !== null) return _builtinRt;
  const m = await pi();
  if (m.ModelRuntime) {
    const rt = await m.ModelRuntime.create({ modelsPath: NO_MODELS_JSON, modelsStorePath: MODELS_STORE });
    _builtinRt = { get: (p, id) => rt.getModel(p, id) };
  } else if (m.AuthStorage && m.ModelRegistry) {
    const reg = m.ModelRegistry.create(m.AuthStorage.create(), NO_MODELS_JSON);
    _builtinRt = { get: (p, id) => reg.find(p, id) };
  } else {
    _builtinRt = { get: () => undefined };
  }
  return _builtinRt;
}

/**
 * Refresh pi's model catalog from pi.dev (prices, context windows, new models) into
 * models-store.json. Session runtimes stay offline and read that file, so a chat never
 * waits on the network; this runs at startup and on every catalog probe. pi itself skips
 * the fetch when the stored copy is under 4 hours old, unless `force`.
 */
export async function refreshModelCatalog({ force = false, timeoutMs = 20000 } = {}) {
  const m = await pi();
  if (!m.ModelRuntime) return { refreshed: false, reason: "pi runtime predates the remote catalog" };
  const rt = await m.ModelRuntime.create({
    modelsPath: NO_MODELS_JSON, modelsStorePath: MODELS_STORE,
    allowModelNetwork: true, refreshOnCreate: false,
  });
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await rt.refresh({ allowNetwork: true, force, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
  _builtinRt = null;   // next builtinModel() sees the new catalog
  return { refreshed: true, store: MODELS_STORE };
}

/** Does pi itself define this model (bundled or its refreshed catalog), ignoring models.json? */
export async function builtinModel(provider, id) {
  const rt = await builtinRuntime();
  try { return rt.get(provider, id); } catch { return undefined; }
}

/**
 * Build a runtime with the given provider keys applied as runtime overrides
 * (never persisted to disk - the keys belong to the RMM database).
 * @param {object} keys  { anthropic: "sk-...", openai: "..." }
 */
export async function piRuntime(keys = {}) {
  const m = await pi();

  // ---- 0.81+ : one async ModelRuntime -------------------------------------
  if (m.ModelRuntime) {
    const rt = await m.ModelRuntime.create({ modelsPath: MODELS_JSON });
    for (const [prov, key] of Object.entries(keys)) if (key) rt.setRuntimeApiKey(prov, key);
    patchXhigh(rt);
    return {
      generation: "modelruntime",
      raw: rt,
      findModel: (provider, id) => rt.getModel(provider, id),
      // ONLY MODELS WE HOLD A KEY FOR - the contract the pre-0.81 path met with getAvailable().
      // getModels() is the whole catalog (~1700), so after the 2026-09-30 runtime update the
      // compaction picker chose amazon-bedrock/llama4-scout (largest window, no key) and
      // summarising failed on TICKET/61934. If the auth snapshot is not ready yet, fall back
      // to the full list rather than returning nothing.
      listModels: () => {
        const all = rt.getModels();
        let usable = all;
        try { usable = all.filter((m) => rt.hasConfiguredAuth(m.provider)); } catch { usable = all; }
        return (usable.length ? usable : all).map(toRow);
      },
      sessionOpts: { modelRuntime: rt },
      loadError: () => (rt.getError ? rt.getError() : undefined),
    };
  }

  // ---- pre-0.81 : AuthStorage + ModelRegistry ------------------------------
  if (m.AuthStorage && m.ModelRegistry) {
    const auth = m.AuthStorage.create();
    for (const [prov, key] of Object.entries(keys)) if (key) auth.setRuntimeApiKey(prov, key);
    // create() (not inMemory()) so models.json is honoured - that is what makes a model
    // the provider has released but this package does not know about runnable.
    const reg = m.ModelRegistry.create(auth, MODELS_JSON);
    patchXhigh(reg);
    return {
      generation: "authstorage",
      raw: reg,
      findModel: (provider, id) => reg.find(provider, id),
      // getAvailable() filters to providers that have a key, which is what every caller
      // here wants (a model with no key is not usable).
      listModels: () => reg.getAvailable().map(toRow),
      sessionOpts: { authStorage: auth, modelRegistry: reg },
      loadError: () => (reg.getError ? reg.getError() : undefined),
    };
  }

  throw new Error(
    `installed pi runtime exposes neither ModelRuntime nor AuthStorage - cannot start ` +
    `(exports seen: ${Object.keys(m).slice(0, 12).join(", ")}...)`,
  );
}

function toRow(x) {
  return {
    provider: x.provider,
    model_id: x.id,
    display_name: x.name || x.id,
    reasoning: !!x.reasoning,
    context_window: x.contextWindow,
    // The rate card pi prices this model with (USD per million tokens), or null. An
    // all-zero card is "unpriced", not free.
    cost: x.cost && (x.cost.input || x.cost.output) ? x.cost : null,
    // What this model will actually honour. "xhigh"/"max" are absent unless the model's
    // thinkingLevelMap names them — offering them otherwise is a lie, setThinkingLevel
    // clamps them away before the request is sent.
    // A map that nulls every level (grok-build-0.1: xAI rejects reasoningEffort at any
    // value, including "none") comes back empty. Offer "off" so the settings UI does not
    // fall back to high/xhigh, which the API would 400.
    thinking_levels: getSupportedThinkingLevels(x).length ? getSupportedThinkingLevels(x) : ["off"],
  };
}

/**
 * Functional self-test used by the scheduled updater BEFORE a new version is allowed to
 * take over. Deliberately behaviour-based: "can this build a runtime, apply a key and
 * find a model", not "does export X still exist". An export list goes stale; this does not.
 */
export async function piSelfTest(keys = {}) {
  const out = { pkg: PKG };
  try {
    out.generation = await piGeneration();
    const rt = await piRuntime(keys);
    const models = rt.listModels();
    out.models = models.length;
    out.load_error = rt.loadError() || null;
    out.session_opts = Object.keys(rt.sessionOpts);
    // Prove the lookup path used by every surface actually resolves something.
    const first = models[0];
    out.lookup_ok = !!(first && rt.findModel(first.provider, first.model_id));
    out.ok = out.models > 0 && out.lookup_ok && !out.load_error;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = String(e?.message || e);
    return out;
  }
}

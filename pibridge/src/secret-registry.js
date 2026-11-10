// Secret registry: the last line of defence between a stored credential and the model.
//
// The gate's first layer is structural: the model is never handed a credential value
// (reads return labels and "has_password", brokered commands get the value in their
// environment). This module is the second layer. Every value the bridge has ever read from
// the IT Notebook (or any other store of secrets) is registered here for the session, and
// every string that is about to reach the model, the transcript or an outbound message is
// passed through redact(). The value is replaced by a label, in every encoding it could
// plausibly appear in: raw, JSON-escaped, base64, base64url and URL-encoded.
//
// It cannot recognise a secret that was never registered. That is why registration happens
// at the read site, not at the output site, and why outbound content is also DLP-checked.

import { createHash } from "node:crypto";

const MIN_LEN = 6; // shorter strings produce too many false positives to be useful
// Digest matching (values known only by their SHA-256, e.g. generated passwords reloaded after a
// restart): the text is split into tokens on these delimiters and each token is hashed.
const TOKEN_SPLIT = /([\s"'`,;.()<>\[\]{}|&:]+)/;
const DIGEST_MIN = 8;
export const digestOf = (v) => createHash("sha256").update(String(v), "utf8").digest("hex");

function variants(value) {
  const out = new Set([value]);
  const json = JSON.stringify(value).slice(1, -1);
  out.add(json);
  const b64 = Buffer.from(value, "utf8").toString("base64");
  out.add(b64);
  out.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  out.add(encodeURIComponent(value));
  out.add(encodeURIComponent(value).replace(/%20/g, "+"));
  return [...out].filter((v) => v && v.length >= MIN_LEN);
}

export class SecretRegistry {
  constructor() {
    this.labels = new Map(); // needle -> label
    this.patterns = null;    // compiled alternation, rebuilt on change
    this.digests = new Map(); // sha256(value) -> label, for values held only as a digest
  }

  /** Register a value known only by its SHA-256 (reloaded from the state file after a restart). */
  addDigest(label, digest) {
    if (/^[0-9a-f]{64}$/.test(String(digest))) this.digests.set(digest, label);
    return this;
  }

  /** Register a secret value under a label. The label is what the model sees instead. */
  add(label, value) {
    if (typeof value !== "string" || value.length < MIN_LEN) return 0;
    let n = 0;
    for (const v of variants(value)) {
      if (!this.labels.has(v)) { this.labels.set(v, label); n++; }
    }
    this.patterns = null;
    return n;
  }

  get size() { return this.labels.size; }

  _rx() {
    if (!this.patterns && this.labels.size) {
      const esc = [...this.labels.keys()]
        .sort((a, b) => b.length - a.length) // longest first so overlaps resolve to the whole secret
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      this.patterns = new RegExp(esc.join("|"), "g");
    }
    return this.patterns;
  }

  /** Replace every registered secret in a string. Returns the string unchanged if none. */
  redact(s) {
    if (typeof s !== "string") return s;
    let out = s;
    if (this.labels.size) {
      const rx = this._rx();
      rx.lastIndex = 0;
      out = out.replace(rx, (m) => `[REDACTED:${this.labels.get(m) || "secret"}]`);
    }
    return this._redactTokens(out);
  }

  _redactTokens(s) {
    if (!this.digests.size) return s;
    return s.split(TOKEN_SPLIT).map((part, i) => {
      if (i % 2 === 1 || part.length < DIGEST_MIN) return part; // odd indexes are the delimiters
      for (const c of [part, part.replace(/[!?]+$/, "")]) {
        const label = this.digests.get(digestOf(c));
        if (label) return `[REDACTED:${label}]`;
      }
      return part;
    }).join("");
  }

  /** Deep-redact any JSON-like value (tool results, prompts, transcripts). */
  redactDeep(v) {
    if (typeof v === "string") return this.redact(v);
    if (Array.isArray(v)) return v.map((x) => this.redactDeep(x));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = this.redactDeep(x);
      return o;
    }
    return v;
  }
}

/**
 * Wrap a pi tool so everything it returns is redacted before the model sees it.
 * Errors pass through the same redaction, because error text often echoes its input.
 */
export function wrapToolRedaction(tool, registry) {
  if (!tool || typeof tool.execute !== "function" || tool.execute.__redacted) return tool;
  const original = tool.execute;
  const wrapped = async (...args) => {
    try {
      return registry.redactDeep(await original(...args));
    } catch (e) {
      const msg = registry.redact(String(e?.message || e));
      const err = new Error(msg);
      throw err;
    }
  };
  wrapped.__redacted = true;
  tool.execute = wrapped;
  return tool;
}

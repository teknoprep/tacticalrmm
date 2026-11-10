// Generated-password digests, kept across bridge restarts (2026-11-10).
//
// A reset generates a password the model must never see. While the bridge runs it is held as
// plaintext in the secret registry (exact matching, every encoding). After a restart only its
// SHA-256 is kept, in PI_STATE_DIR/generated-secrets.json (mode 0600). A 20-character random
// password from this alphabet cannot be recovered from its digest, so the file holds no secret.
// Only whole tokens are matched after a restart (see secret-registry.js).
//
// Entries expire after PI_GENERATED_SECRET_TTL_DAYS (default 30). After expiry a typed copy of
// the value is no longer recognised; the account should have been changed long before then.
import fs from "node:fs";
import path from "node:path";
import { digestOf } from "./secret-registry.js";

export const STATE_DIR = process.env.PI_STATE_DIR || path.join(process.cwd(), "state");
export const GENERATED_FILE = path.join(STATE_DIR, "generated-secrets.json");
const TTL_DAYS = Number(process.env.PI_GENERATED_SECRET_TTL_DAYS) || 30;

function readAll(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeAll(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Load unexpired digests into the registry; prune expired ones from the file. */
export function loadGeneratedSecrets({ registry, file = GENERATED_FILE, now = Date.now() }) {
  const all = readAll(file);
  const keep = all.filter((e) => e && e.digest && Date.parse(e.expires) > now);
  if (keep.length !== all.length) writeAll(file, keep);
  for (const e of keep) registry.addDigest(e.label, e.digest);
  return keep.length;
}

/** Remember a generated value by its digest only. Returns the digest. */
export function rememberGeneratedSecret({ registry, label, value, file = GENERATED_FILE, ttlDays = TTL_DAYS, now = Date.now() }) {
  const digest = digestOf(value);
  const list = readAll(file).filter((e) => e && Date.parse(e.expires) > now && e.digest !== digest);
  list.push({
    digest,
    label: String(label).slice(0, 200),
    created: new Date(now).toISOString(),
    expires: new Date(now + ttlDays * 86400000).toISOString(),
  });
  writeAll(file, list);
  registry.addDigest(label, digest);
  return digest;
}

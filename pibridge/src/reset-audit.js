// Audit trail for reset_device_password (2026-11-10). One JSON line per attempt, in
// PI_STATE_DIR/audit/password-resets.jsonl (directory 0700, file 0600). Never a password:
// every free-text field is passed through the secret registry first.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./generated-secrets.js";
import { SECRETS } from "./secret-store.js";

export const AUDIT_FILE = path.join(STATE_DIR, "audit", "password-resets.jsonl");

export function auditReset(entry, { file = AUDIT_FILE, registry = SECRETS } = {}) {
  const clean = Object.fromEntries(
    Object.entries(entry).map(([k, v]) => [k, typeof v === "string" ? registry.redact(v).slice(0, 300) : v]),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event: "password_reset", ...clean }) + "\n", { mode: 0o600 });
}

// Brand identity is DEPLOYMENT CONFIG, not source code.
//
// This file used to hard-code one company's name, legal entity, phone number, postal
// address, support mailbox and logo URL. That is wrong twice over: this repository is a
// fork of an open-source product and is public, so the identity of whoever runs it does
// not belong in it; and an operator who wants their own branding should not have to edit
// JavaScript to get it.
//
// So the defaults below are deliberately generic and obviously-placeholder. Real values
// are read at startup from a JSON file that is NOT in git:
//
//     PI_BRAND_FILE=/etc/pi-trmm-brand.json    (default path)
//
// Anything absent from that file falls back to the placeholder, so a fresh clone runs
// without carrying anyone's identity, and a configured deployment looks exactly as it did.

import fs from "node:fs";

const BRAND_DEFAULTS = {
  name: "Example IT",
  legalName: "Example IT Services, LLC",
  tagline: "IT Solutions, Simplified.",
  phone: "555-0100",
  phoneTel: "+15550100",
  supportEmail: "support@example.com",
  infoEmail: "info@example.com",
  web: "https://www.example.com",
  address: "1 Example Street, Example City, EX 00000",
  // Logo shown in outbound HTML. Empty means "no logo image" and the templates degrade
  // to the company name, which is why it must not be a broken URL.
  logoUrl: "",
  // Tokens
  primary: "#0F62FE",
  primaryDark: "#0043CE",
  primaryHover: "#4589FF",
  text: "#212529",
  dark: "#1B1319",
  muted: "#495057",
  light: "#F6F5F4",
  white: "#FFFFFF",
  border: "#dee2e6",
  page: "#F0F2F5",
  warnBg: "#fff8e6",
  warnBorder: "#e6c200",
};

function loadBrand() {
  const file = process.env.PI_BRAND_FILE || "/etc/pi-trmm-brand.json";
  try {
    const raw = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(raw);
    // Only known keys, and only non-empty values: a typo in the config file must not
    // silently blank out a colour the templates depend on.
    const out = { ...BRAND_DEFAULTS };
    for (const k of Object.keys(BRAND_DEFAULTS)) {
      if (cfg[k] !== undefined && cfg[k] !== null && String(cfg[k]).trim() !== "") out[k] = cfg[k];
    }
    return out;
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.log(`${new Date().toISOString()} brand config unreadable (${file}): ${e?.message || e} - using defaults`);
    }
    return { ...BRAND_DEFAULTS };
  }
}

export const BRAND = loadBrand();

/** One-block policy text injected into AI system prompts. */
export function brandEmailPolicy() {
  const b = BRAND;
  return (
    `${b.name.toUpperCase()} BRAND HTML (mandatory for every send_email html and every quotation note_html):\n` +
    `- Primary accent: ${b.primary} (cyan). Deeper accent/links: ${b.primaryDark}.\n` +
    `- Body text: ${b.text} or ${b.dark} on light backgrounds ${b.white} / ${b.light} / ${b.page}.\n` +
    `- NEVER white/light text on navy, black, or gradient headers. Prefer white header band + logo + ${b.primary} bottom border.\n` +
    // No logo configured must not become <img src="">, which renders as a broken image in
    // every mail client. Say the company name instead - that is what the logo was for.
    (b.logoUrl
      ? `- Logo (light bg): <img src="${b.logoUrl}" alt="${b.name}" width="140" style="display:block;border:0;max-width:140px;height:auto;" />\n`
      : `- No logo image is configured: use the company name "${b.name}" as text in the header, never an <img> with an empty src.\n`) +
    `- Table headers: background ${b.primary}; color ${b.text} (dark on cyan — readable if bg strips). Border ${b.primaryDark}.\n` +
    `- Section titles: ${b.dark} weight 700 with left border 4px solid ${b.primary}.\n` +
    `- Option/highlight cards: border 2px solid ${b.primary}; recommended option header may use bg ${b.primary} with color ${b.text} (NOT white).\n` +
    `- Footer strip: bg ${b.light}, logo + ${b.legalName}, ${b.address}, ${b.phone}, ${b.supportEmail}, ${b.web}.\n` +
    `- Tagline: "${b.tagline}". Company: ${b.legalName}.\n` +
    `- Outer page bg ${b.page}; content card white with subtle border ${b.border}.\n` +
    `- Inline styles only; table-based layout; no <style> blocks; no scripts.\n`
  );
}

/** Shared inline style snippets for deterministic JS templates (sales.js can mirror these hex values). */
export function brandStyles() {
  const b = BRAND;
  return {
    th: `padding:9px 11px;border:1px solid ${b.primaryDark};background-color:${b.primary};color:${b.text};text-align:left;font-size:13px;font-weight:700;`,
    td: `padding:8px 11px;border:1px solid ${b.border};background-color:${b.white};color:${b.text};font-size:13px;vertical-align:top;`,
    tdAlt: `padding:8px 11px;border:1px solid ${b.border};background-color:${b.light};color:${b.text};font-size:13px;vertical-align:top;`,
    hSec: `font-size:16px;font-weight:700;color:${b.dark};margin:18px 0 8px;border-left:4px solid ${b.primary};padding-left:10px;`,
    muted: `color:${b.muted};font-size:13px;`,
    body: `margin:0;padding:0;background:${b.page};font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${b.text};`,
  };
}

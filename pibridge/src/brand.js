// BlueCloud brand tokens — sourced from www.blueuc.com (Odoo website CSS).
// Used in AI email/quote HTML guidance so every outbound message matches the site.
//
// READABILITY: primary buttons on the site use dark text ON cyan (#212529 on #00C4FF).
// We never put white text on colored headers — if a client strips backgrounds, copy stays readable.

export const BRAND = {
  name: "BlueCloud",
  legalName: "BlueCloud IAAS, LLC",
  tagline: "IT Solutions, Simplified.",
  phone: "855-258-3456",
  phoneTel: "+18552583456",
  supportEmail: "support@blueuc.com",
  infoEmail: "info@blueuc.com",
  web: "https://www.blueuc.com",
  address: "5371 Allentown Pike, Reading, PA 19560",
  // Color logo (for light backgrounds) — public CDN
  logoUrl: "https://www.blueuc.com/web/image/1330-24f164ad/blue_cloud_logo_A.png",
  // Tokens
  primary: "#00C4FF",
  primaryDark: "#007294",
  primaryHover: "#26cdff",
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

/** One-block policy text injected into AI system prompts. */
export function brandEmailPolicy() {
  const b = BRAND;
  return (
    `BLUECLOUD BRAND HTML (mandatory for every send_email html and every quotation note_html):\n` +
    `- Primary accent: ${b.primary} (cyan). Deeper accent/links: ${b.primaryDark}.\n` +
    `- Body text: ${b.text} or ${b.dark} on light backgrounds ${b.white} / ${b.light} / ${b.page}.\n` +
    `- NEVER white/light text on navy, black, or gradient headers. Prefer white header band + logo + ${b.primary} bottom border.\n` +
    `- Logo (light bg): <img src="${b.logoUrl}" alt="BlueCloud" width="140" style="display:block;border:0;max-width:140px;height:auto;" />\n` +
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

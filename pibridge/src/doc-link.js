// READ A DOCUMENT FROM A LINK (SharePoint / OneDrive / Teams) — owner ask, 2026-11-02.
//
// WHY THIS EXISTS: a technician pastes a SharePoint link ("here is the spec / the client's
// onboarding doc") and the only thing the model can do with it is `web_fetch`, which gets the
// MICROSOFT SIGN-IN PAGE — 60 KB of HTML that says nothing. It then either says "I can't read
// that" or, worse, guesses. intranet documents are where half the facts live, so the bot has to
// be able to read them.
//
// HOW: Microsoft Graph, app-only. A SharePoint sharing link is resolved through
//   GET /shares/u!<base64url(link)>/driveItem
// and the item's content is downloaded. Word/Excel/PowerPoint are converted server-side by
// Graph (`?format=pdf`) and the text is extracted with the same `unpdf` path the attachment
// reader already uses, so no new dependency and no local Office install.
//
// CREDENTIALS (one-time, admin): an Entra app registration with the APPLICATION permissions
// `Files.Read.All` + `Sites.Read.All` and admin consent, then in /etc/pi-trmm-bridge.env:
//   M365_GRAPH_TENANT=blueuc.com           (or a tenant GUID)
//   M365_GRAPH_CLIENT_ID=<application id>
//   M365_GRAPH_CLIENT_SECRET=<client secret>       (simplest)
//   ...or a certificate instead of a secret:
//   M365_GRAPH_CERT_PATH=/etc/pi-trmm-bridge/m365.pem
//   M365_GRAPH_CERT_PASS=<passphrase, optional>
// See docs/DOCUMENT-LINKS.md. Nothing here is enabled until those are set; until then the tool
// answers with the exact reason and what an admin has to do — never with a sign-in page.
//
// SCOPE: read only. This module never writes, uploads or shares anything, and it deliberately
// refuses non-Microsoft links (a Google/Dropbox link is a different credential conversation —
// the caller is told so rather than being sent to fetch the login page).

import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { extractPdf } from "./attachments.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";
const HTTP_TIMEOUT_MS = Number(process.env.PI_DOC_TIMEOUT_MS || 30000);
const DEFAULT_MAX_CHARS = Number(process.env.PI_DOC_MAX_CHARS || 40000);
const DEFAULT_MAX_BYTES = Number(process.env.PI_DOC_MAX_BYTES || 40 * 1024 * 1024);

const env = (k) => String(process.env[k] || "").trim();

/** Everything an operator has to set, in one place, so the failure message can be precise. */
export function graphConfig() {
  const tenant = env("M365_GRAPH_TENANT") || env("M365_TENANT_ID");
  const clientId = env("M365_GRAPH_CLIENT_ID") || env("M365_CLIENT_ID");
  const secret = env("M365_GRAPH_CLIENT_SECRET") || env("M365_CLIENT_SECRET");
  const certPath = env("M365_GRAPH_CERT_PATH");
  const certPass = env("M365_GRAPH_CERT_PASS");
  const missing = [];
  if (!tenant) missing.push("M365_GRAPH_TENANT");
  if (!clientId) missing.push("M365_GRAPH_CLIENT_ID");
  if (!secret && !certPath) missing.push("M365_GRAPH_CLIENT_SECRET (or M365_GRAPH_CERT_PATH)");
  return {
    tenant, clientId, secret, certPath, certPass,
    configured: missing.length === 0,
    missing,
    mode: secret ? "client_secret" : certPath ? "certificate" : "none",
  };
}

/** The message to show a model/technician when nobody has configured the app yet. */
export function unconfiguredHint(cfg = graphConfig()) {
  return (
    "SharePoint/OneDrive reading is not configured on this bridge (missing: " +
    cfg.missing.join(", ") +
    "). An admin adds the M365 Graph app credentials to /etc/pi-trmm-bridge.env and restarts " +
    "the bridge — see docs/DOCUMENT-LINKS.md. Do NOT try to read the link with web_fetch: the " +
    "sign-in page is all it will return. Ask the technician for the document itself, or for the " +
    "content pasted into the chat."
  );
}

// ------------------------------------------------------------------ token (cached)
let tokenCache = { key: "", token: "", exp: 0 };

function certThumbprintB64Url(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return crypto.createHash("sha1").update(Buffer.from(b64, "base64")).digest("base64url");
}

/** RS256 client assertion for certificate auth (no jose/jsonwebtoken dependency). */
function clientAssertion(cfg) {
  const pem = fs.readFileSync(cfg.certPath, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", x5t: certThumbprintB64Url(pem) };
  const payload = {
    aud: `${LOGIN}/${cfg.tenant}/oauth2/v2.0/token`,
    iss: cfg.clientId, sub: cfg.clientId,
    jti: crypto.randomUUID(), nbf: now - 60, exp: now + 600, iat: now,
  };
  const unsigned =
    Buffer.from(JSON.stringify(header)).toString("base64url") + "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createSign("RSA-SHA256").update(unsigned)
    .sign({ key: pem, passphrase: cfg.certPass || undefined });
  return unsigned + "." + sig.toString("base64url");
}

/**
 * App-only Graph token. Cached in-process until a minute before it expires: a document read
 * is bursty (a ticket, then three more) and the token endpoint rate-limits per app+tenant.
 */
export async function graphToken(cfg = graphConfig(), { force = false } = {}) {
  if (!cfg.configured) return null;
  const key = `${cfg.tenant}|${cfg.clientId}|${cfg.mode}`;
  if (!force && tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.exp - 60_000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  if (cfg.secret) {
    body.set("client_secret", cfg.secret);
  } else {
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    try {
      body.set("client_assertion", clientAssertion(cfg));
    } catch (e) {
      throw new Error(`Graph certificate unusable (${cfg.certPath}): ${String(e?.message || e)}`);
    }
  }
  const res = await fetch(`${LOGIN}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const detail = String(j.error_description || j.error || `HTTP ${res.status}`).split("\n")[0];
    throw new Error(`Graph sign-in failed: ${detail}`.slice(0, 400));
  }
  tokenCache = {
    key,
    token: j.access_token,
    exp: Date.now() + Number(j.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

// ------------------------------------------------------------------ link recognition
// Hosts that need an authenticated read. Keeping the list explicit (rather than "anything that
// 302s to a login page") means a normal web page never takes a detour through Graph.
const DOC_HOSTS = [
  /(^|\.)sharepoint\.com$/i,
  /(^|\.)sharepoint\.us$/i,
  /(^|\.)sharepoint\.de$/i,
  /(^|\.)sharepoint\.cn$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /(^|\.)1drv\.ms$/i,
  /(^|\.)svc\.ms$/i,
  /(^|\.)microsoft365\.com$/i,
  /(^|\.)officeapps\.live\.com$/i,
  /(^|\.)teams\.microsoft\.com$/i,
  /(^|\.)teams\.live\.com$/i,
];

// Other document services we RECOGNISE but do not read (so the answer is honest and specific).
const OTHER_DOC_HOSTS = [
  [/(^|\.)docs\.google\.com$/i, "Google Docs/Sheets/Slides"],
  [/(^|\.)drive\.google\.com$/i, "Google Drive"],
  [/(^|\.)dropbox\.com$/i, "Dropbox"],
  [/(^|\.)box\.com$/i, "Box"],
  [/(^|\.)notion\.so$/i, "Notion"],
  [/(^|\.)confluence\.(atlassian\.)?com$/i, "Confluence"],
];

export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; }
}

/** True when the link points at a document we can actually read through Graph. */
export function looksLikeDocumentLink(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  const host = hostOf(url);
  if (!host) return false;
  return DOC_HOSTS.some((re) => re.test(host));
}

/**
 * A Teams "Files" tab link points at Teams, not at the file: the real document is in the
 * `objectUrl` / `fileUrl` query parameter (URL-encoded SharePoint). Resolve that before asking
 * Graph, otherwise every Teams link 404s and looks like a permissions problem.
 */
export function shareLinkFor(raw) {
  const url = String(raw || "").trim();
  try {
    const u = new URL(url);
    if (!/teams\.(microsoft|live)\.com$/i.test(u.hostname)) return url;
    for (const k of ["objectUrl", "fileUrl", "documentUrl"]) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v)) return v.trim();
    }
    return url;
  } catch {
    return url;
  }
}

/** Name the service behind a link we can't read, or "" if it isn't a known document service. */
export function otherDocumentService(raw) {
  const host = hostOf(raw);
  if (!host) return "";
  for (const [re, name] of OTHER_DOC_HOSTS) if (re.test(host)) return name;
  return "";
}

// ------------------------------------------------------------------ Graph plumbing
class GraphError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function graphGetJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = txt.slice(0, 300);
    try { const j = JSON.parse(txt); detail = j?.error?.message || detail; } catch { /* not json */ }
    throw new GraphError(res.status, `Graph ${res.status}: ${String(detail).slice(0, 300)}`, txt);
  }
  try { return JSON.parse(txt); } catch { throw new GraphError(500, "Graph returned non-JSON"); }
}

/**
 * Download a driveItem's content. Graph answers /content with a 302 to a short-lived pre-signed
 * URL on *.sharepoint.com — that URL must be fetched WITHOUT our bearer token (sending it
 * cross-host leaks it into a log we do not control, and undici would follow it silently).
 */
async function graphDownload(url, token, maxBytes = DEFAULT_MAX_BYTES) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let finalRes = res;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new GraphError(res.status, `Graph redirect ${res.status} with no location`);
    finalRes = await fetch(loc, { redirect: "follow", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  }
  if (!finalRes.ok) {
    const t = await finalRes.text().catch(() => "");
    throw new GraphError(finalRes.status, `download failed (${finalRes.status}) ${String(t).slice(0, 200)}`);
  }
  const len = Number(finalRes.headers.get("content-length") || 0);
  if (len && len > maxBytes) {
    throw new GraphError(413, `document is ${(len / 1048576).toFixed(1)} MB, over the ${Math.round(maxBytes / 1048576)} MB read limit`);
  }
  const buf = Buffer.from(await finalRes.arrayBuffer());
  if (buf.length > maxBytes) throw new GraphError(413, `document is over the ${Math.round(maxBytes / 1048576)} MB read limit`);
  return { buf, contentType: String(finalRes.headers.get("content-type") || "") };
}

const PDF_CONVERTIBLE = new Set([
  "doc", "docx", "dot", "dotx", "dotm", "docm", "rtf",
  "xls", "xlsx", "xlsm", "xlsb",
  "ppt", "pptx", "pps", "ppsx", "pptm",
]);
const TEXTY = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yml", "yaml", "ini", "conf", "log",
  "ps1", "sh", "py", "js", "ts", "sql", "html", "htm", "css", "reg", "bat", "cmd", "diff", "patch",
]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"]);

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "").trim());
  return m ? m[1].toLowerCase() : "";
}

// ------------------------------------------------------------------ PUBLIC links (no credentials)
// "Anyone with the link" shares need NO app and NO sign-in. Verified 2026-11-02 on the reported
// link: `<link>&download=1` 302s through SharePoint, and the FIRST hop sets a guest FedAuth cookie
// that the NEXT hop requires. Drop the cookie (plain fetch, curl without a jar) and SharePoint
// sends you to login.microsoftonline.com instead — which is exactly why the bot "could not read" a
// public link. So: manual redirects + a tiny cookie jar, and stop the moment a hop is a sign-in.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function withDownloadFlag(link) {
  try { const u = new URL(link); u.searchParams.set("download", "1"); return u.toString(); } catch { return link; }
}

export function isSignInHop(raw) {
  try {
    const u = new URL(raw);
    return /(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|login\.microsoft\.com)$/i.test(u.hostname) ||
      /\/_layouts\/15\/Authenticate\.aspx/i.test(u.pathname) || /\/_forms\//i.test(u.pathname);
  } catch { return false; }
}

function filenameFrom(res, finalUrl) {
  const cd = String(res.headers.get("content-disposition") || "");
  let m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/"/g, "")); } catch { /* fall through */ } }
  m = /filename="?([^";]+)"?/i.exec(cd);
  if (m) return m[1].trim();
  try { return decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || ""); } catch { return ""; }
}

/**
 * Download a publicly shared M365 document. Returns {ok:true, buf, name, contentType, finalUrl}
 * or {ok:false, reason, signIn?, tooBig?}. Never sends a cookie to a non-Microsoft host and never
 * follows a sign-in hop (that is the "this link is not public" answer, not an error).
 */
export async function anonymousDownload(link, { maxBytes = DEFAULT_MAX_BYTES, fetchImpl = fetch } = {}) {
  const jar = new Map();
  let url = withDownloadFlag(link);
  for (let hop = 0; hop < 10; hop++) {
    if (isSignInHop(url)) return { ok: false, signIn: true, reason: "SharePoint asked for a sign-in — the link is not shared with 'Anyone with the link'" };
    const host = hostOf(url);
    const headers = { "User-Agent": BROWSER_UA, Accept: "*/*" };
    if (jar.size && DOC_HOSTS.some((re) => re.test(host))) {
      headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = String(c).split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, reason: `redirect ${res.status} with no location` };
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) return { ok: false, reason: `SharePoint answered HTTP ${res.status}`, status: res.status };
    const type = String(res.headers.get("content-type") || "");
    if (/text\/html/i.test(type)) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: false, reason: "SharePoint returned a web page instead of the file (viewer or sign-in)" };
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return { ok: false, tooBig: true, reason: `the file is ${(len / 1048576).toFixed(1)} MB, over the ${Math.round(maxBytes / 1048576)} MB read limit` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, tooBig: true, reason: `the file is over the ${Math.round(maxBytes / 1048576)} MB read limit` };
    return { ok: true, buf, contentType: type, name: filenameFrom(res, url), finalUrl: url };
  }
  return { ok: false, reason: "too many redirects" };
}

// ------------------------------------------------------------------ Office files, in-process
// Word/Excel/PowerPoint (docx/dotx/xlsx/pptx...) are ZIP files of XML. Reading them here means a
// public link needs no Graph at all (Graph's ?format=pdf conversion is only used when a private
// link came through Graph AND the in-process read found nothing, e.g. a legacy binary .doc).

/** Minimal ZIP reader (central directory + stored/deflate). No ZIP64: Office docs are far below 4 GB. */
export function unzipEntries(buf, wanted = () => true, { maxEntryBytes = 60 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22, stop = Math.max(0, buf.length - 65557); i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!wanted(name) || usize > maxEntryBytes) continue;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes }));
  }
  return out;
}

function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function wordXmlToText(xml) {
  return xmlDecode(String(xml)
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "")       // tracked deletions are not the text
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")   // field codes (TOC, MERGEFIELD...)
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<w:cr\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t").replace(/<\/w:tr>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, ""));
}

const numOf = (name) => Number((/(\d+)\.xml$/.exec(name) || [])[1] || 0);

function docxText(z) {
  const parts = [];
  const body = z.get("word/document.xml");
  if (body) parts.push(wordXmlToText(body.toString("utf8")));
  for (const [label, key] of [["footnotes", "word/footnotes.xml"], ["endnotes", "word/endnotes.xml"], ["comments", "word/comments.xml"]]) {
    const x = z.get(key);
    const t = x ? wordXmlToText(x.toString("utf8")).trim() : "";
    if (t) parts.push(`\n[${label}]\n${t}`);
  }
  return parts.join("\n");
}

function pptxText(z) {
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => numOf(a) - numOf(b));
  return slides.map((k) => {
    const t = xmlDecode(z.get(k).toString("utf8").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).trim();
    const notesBuf = z.get(`ppt/notesSlides/notesSlide${numOf(k)}.xml`);
    const notes = notesBuf ? xmlDecode(notesBuf.toString("utf8").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).trim() : "";
    return `--- slide ${numOf(k)} ---\n${t}${notes ? `\n[notes] ${notes}` : ""}`;
  }).join("\n\n");
}

function xlsxText(z, { maxRows = 5000 } = {}) {
  const ssXml = z.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlDecode(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "")));
  const wb = z.get("xl/workbook.xml")?.toString("utf8") || "";
  const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => xmlDecode(m[1]));
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => numOf(a) - numOf(b));
  let rowsLeft = maxRows;
  const out = [];
  sheets.forEach((k, idx) => {
    const xml = z.get(k).toString("utf8");
    const lines = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rowsLeft-- <= 0) break;
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] || "", inner = c[2] || "";
        const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || "";
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let val = "";
        if (t === "s") val = shared[Number(v)] ?? "";
        else if (t === "inlineStr") val = xmlDecode(inner.replace(/<[^>]+>/g, ""));
        else if (v != null) val = xmlDecode(v);
        cells.push(val);
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.length) lines.push(cells.join("\t"));
    }
    out.push(`--- sheet: ${names[idx] || `Sheet${numOf(k)}`} ---\n${lines.join("\n")}`);
  });
  if (rowsLeft < 0) out.push(`[stopped after ${maxRows} rows]`);
  return out.join("\n\n");
}

/**
 * Text from a downloaded file. Sniffs the bytes rather than trusting the name/mime, because a
 * share's content-type is often generic. Returns {text, kind, note}; text "" = nothing readable.
 */
export async function extractFromBuffer(buf, name = "", contentType = "") {
  const ext = extOf(name);
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "%PDF") {
    const pdf = await extractPdf(buf, { maxPages: 80 });
    return { text: pdf.text, kind: "pdf", note: pdf.encrypted ? "the PDF is password-protected" : (pdf.text.trim() ? "" : "the PDF has no selectable text (scanned?)") };
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    let z;
    try { z = unzipEntries(buf, (n) => /^(word|ppt|xl)\//.test(n) && n.endsWith(".xml")); }
    catch (e) { return { text: "", kind: "zip", note: `could not open the file (${String(e?.message || e)})` }; }
    if (z.has("word/document.xml")) return { text: docxText(z), kind: "word", note: "" };
    if ([...z.keys()].some((k) => k.startsWith("ppt/slides/"))) return { text: pptxText(z), kind: "powerpoint", note: "" };
    if (z.has("xl/workbook.xml")) return { text: xlsxText(z), kind: "excel", note: "" };
    return { text: "", kind: "zip", note: "a ZIP file that is not a Word/Excel/PowerPoint document" };
  }
  if (IMAGES.has(ext) || /^image\//i.test(contentType)) return { text: "", kind: "image", note: "it is an image" };
  if (TEXTY.has(ext) || /^text\/|json|xml|csv/i.test(contentType) || looksUtf8(buf)) {
    return { text: buf.toString("utf8"), kind: "text", note: "" };
  }
  return { text: "", kind: ext || "binary", note: `unsupported file type '${ext || contentType || "?"}' (legacy binary .doc/.xls/.ppt need Graph conversion)` };
}

function looksUtf8(buf) {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) { const b = buf[i]; if (b === 0) return false; if (b < 9 || (b > 13 && b < 32)) bad++; }
  return bad / n < 0.05;
}

/** Graph route for PRIVATE links: resolve the share, download, extract; PDF conversion as last resort. */
async function readViaGraph(link, cfg, opts, notes) {
  let token = opts.token;
  try {
    token = token || await graphToken(cfg);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), hint: "An admin must check the M365 Graph app credentials (docs/DOCUMENT-LINKS.md)." };
  }
  const shareId = "u!" + Buffer.from(link, "utf8").toString("base64url");
  let item;
  try {
    item = await graphGetJson(`${GRAPH}/shares/${shareId}/driveItem?$select=id,name,size,file,folder,webUrl,parentReference`, token);
  } catch (e) {
    const status = e?.status || 0;
    if (status === 403 || status === 401) {
      return { ok: false, error: `Graph refused the read (${status}). The app is probably missing Files.Read.All / Sites.Read.All, or the document blocks app access.`, hint: "An admin grants the two application permissions with admin consent (docs/DOCUMENT-LINKS.md)." };
    }
    if (status === 404) {
      return { ok: false, error: "the link did not resolve (404): expired, revoked, or in a tenant the app has no service principal in.", hint: "Ask for a fresh link, or for the file to be attached." };
    }
    return { ok: false, error: String(e?.message || e) };
  }
  if (!item?.id) return { ok: false, error: "the link resolved to no drive item" };
  if (item.folder) return { ok: false, error: `that link is a FOLDER (${item.name || "unnamed"}), not a document.` };
  const ref = { driveId: item.parentReference?.driveId || "", itemId: item.id };
  const name = String(item.name || "document");
  let text = "", bytes = Number(item.size || 0), kind = "";
  try {
    const dl = await graphDownload(`${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/content`, token);
    bytes = dl.buf.length || bytes;
    const ex = await extractFromBuffer(dl.buf, name, dl.contentType);
    text = ex.text; kind = ex.kind;
    if (ex.note) notes.push(ex.note);
    if (!String(text).trim() && PDF_CONVERTIBLE.has(extOf(name))) {
      const pdfDl = await graphDownload(`${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/content?format=pdf`, token);
      const pdf = await extractPdf(pdfDl.buf, { maxPages: 80 });
      text = pdf.text;
      if (text.trim()) notes.push("text taken from Graph's PDF conversion");
    }
  } catch (e) {
    return { ok: false, error: `download/extract failed: ${String(e?.message || e).slice(0, 300)}`, name, webUrl: item.webUrl || link };
  }
  return { ok: true, text, name, bytes, kind, webUrl: item.webUrl || link, mime: item.file?.mimeType || "", source: "microsoft-graph" };
}

/**
 * Read one document behind a link. Order: the PUBLIC route (no credentials) first, then Graph if
 * configured. Never throws for an expected failure — a tool result the model can act on beats a
 * stack trace.
 *
 * @param {string} url
 * @param {{offset?:number, maxChars?:number, token?:string, cfg?:object, fetchImpl?:Function, anonymous?:boolean}} opts
 */
export async function readDocumentText(url, opts = {}) {
  const raw = String(url || "").trim();
  const link = shareLinkFor(raw);
  const offset = Math.max(0, Number(opts.offset || 0));
  const maxChars = Math.max(2000, Number(opts.maxChars || DEFAULT_MAX_CHARS));
  const cfg = opts.cfg || graphConfig();
  const tryAnonymous = opts.anonymous ?? (process.env.PI_DOC_ANONYMOUS !== "0");

  if (!/^https?:\/\//i.test(link)) return { ok: false, error: `not an http(s) link: ${link.slice(0, 120)}` };
  if (!looksLikeDocumentLink(link)) {
    const other = otherDocumentService(link);
    if (other) {
      return { ok: false, error: `${other} links are not readable from here — only Microsoft 365 (SharePoint/OneDrive/Teams) documents are.`, hint: "Ask the technician to download it and attach the file to the chat, or paste the relevant text." };
    }
    return { ok: false, error: "that is not a SharePoint/OneDrive/Teams document link", hint: "Use web_fetch for ordinary web pages." };
  }

  const notes = [];
  let got = null;
  let anonReason = "";
  if (tryAnonymous) {
    try {
      const a = await anonymousDownload(link, { fetchImpl: opts.fetchImpl || fetch });
      if (a.ok) {
        const ex = await extractFromBuffer(a.buf, a.name, a.contentType);
        if (ex.note) notes.push(ex.note);
        if (ex.kind === "image") {
          return { ok: false, error: `that link is an image (${a.name}).`, hint: "Ask for it to be attached to the chat instead — the window can send an image to a vision model.", name: a.name, webUrl: link };
        }
        got = { ok: true, text: ex.text, name: a.name || "document", bytes: a.buf.length, kind: ex.kind, webUrl: link, mime: a.contentType, source: "public-link" };
        if (!String(ex.text).trim()) anonReason = `downloaded '${a.name}' publicly but ${ex.note || "found no text"}`;
      } else {
        anonReason = a.reason;
        if (a.tooBig) return { ok: false, error: a.reason };
      }
    } catch (e) {
      anonReason = `public download failed: ${String(e?.message || e).slice(0, 200)}`;
    }
  }

  if (!got?.text?.trim()) {
    if (!cfg.configured) {
      if (got && !got.text.trim()) {
        return { ok: false, error: `no readable text came out of '${got.name}': ${notes.join("; ") || "empty"}.`, hint: "Attach the file to the chat instead, or paste the relevant section.", name: got.name, webUrl: link };
      }
      return {
        ok: false,
        unconfigured: true,
        missing: cfg.missing,
        error: `${anonReason ? anonReason + ". " : ""}This link is not public, and private-document reading (Graph) is not configured on this bridge (missing: ${cfg.missing.join(", ")}).`,
        hint: "Ask for the share to be set to 'Anyone with the link', or for the file to be attached — or an admin configures Graph (docs/DOCUMENT-LINKS.md). Do not retry with web_fetch: it only gets the sign-in page.",
      };
    }
    const g = await readViaGraph(link, cfg, opts, notes);
    if (!g.ok) return anonReason ? { ...g, error: `${g.error} (public route: ${anonReason})` } : g;
    got = g;
  }

  let text = String(got.text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    return { ok: false, error: `no readable text came out of '${got.name}'. ${notes.join(" ")}`.trim(), hint: "Attach the file to the chat instead, or paste the relevant section.", name: got.name, webUrl: got.webUrl };
  }
  const total = text.length;
  const slice = text.slice(offset, offset + maxChars);
  const truncated = offset + slice.length < total;
  const header = `${got.name}${got.bytes ? ` (${(got.bytes / 1024).toFixed(0)} KB)` : ""} — ${total.toLocaleString()} characters of text` +
    ` [${got.source === "public-link" ? "public link" : "Microsoft Graph"}]`;
  const footer = truncated
    ? `\n\n[showing characters ${offset.toLocaleString()}–${(offset + slice.length).toLocaleString()} of ${total.toLocaleString()} — call read_document with offset=${offset + slice.length} for the next part]`
    : "";
  const noteLine = notes.length ? `\n[${notes.join("; ")}]` : "";
  return {
    ok: true, name: got.name, webUrl: got.webUrl, bytes: got.bytes, mime: got.mime || "", kind: got.kind || "",
    totalChars: total, offset, truncated, nextOffset: truncated ? offset + slice.length : null,
    source: got.source, text: `${header}${noteLine}\n\n${slice}${footer}`, raw: slice,
  };
}

/** Small server-side probe used by docs/tests: does the app get a token and can it see a site? */
export async function graphProbe() {
  const cfg = graphConfig();
  if (!cfg.configured) return { ok: false, configured: false, missing: cfg.missing };
  try {
    const token = await graphToken(cfg);
    const me = await graphGetJson(`${GRAPH}/organization?$select=id,displayName`, token);
    const org = (me?.value || [])[0] || {};
    return { ok: true, configured: true, mode: cfg.mode, tenant: org.displayName || "", tenantId: org.id || cfg.tenant };
  } catch (e) {
    return { ok: false, configured: true, mode: cfg.mode, error: String(e?.message || e) };
  }
}

/** Where an admin looks if a read fails: no secrets, just what is set. */
export function describeConfig() {
  const cfg = graphConfig();
  return {
    configured: cfg.configured,
    mode: cfg.mode,
    tenant: cfg.tenant,
    clientId: cfg.clientId ? `${cfg.clientId.slice(0, 8)}…` : "",
    certPath: cfg.certPath || "",
    missing: cfg.missing,
    envFile: "/etc/pi-trmm-bridge.env",
  };
}

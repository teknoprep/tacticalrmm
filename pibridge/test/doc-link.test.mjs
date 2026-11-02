import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeDocumentLink, otherDocumentService, extOf, graphConfig, describeConfig,
  unconfiguredHint, readDocumentText, shareLinkFor, anonymousDownload, extractFromBuffer, unzipEntries, withDownloadFlag,
} from "../src/doc-link.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// Pure tests only: no network, no credentials. The live path is exercised by
// `sudo scripts/graph-setup.sh` (it probes Graph and prints the organisation).

test("recognises Microsoft 365 document links", () => {
  const yes = [
    "https://blueucadmin.sharepoint.com/:w:/g/IQA5gvcfkdD2Q6Xm2NAM6b_BAcRRL2pCPMvZdcobHfZiO54?rtime=Gj2vbBo530g",
    "https://blueucadmin.sharepoint.com/sites/Support/Shared%20Documents/Spec.docx",
    "https://blueucadmin.sharepoint.com/_layouts/15/Doc.aspx?sourcedoc=%7B1ff78239%7D&action=default",
    "https://contoso-my.sharepoint.com/personal/chris_contoso_com/Documents/notes.docx",
    "https://teams.microsoft.com/l/file/0F0E0A1B?threadId=19:abc&objectUrl=https%3A%2F%2Fcontoso.sharepoint.com",
    "https://1drv.ms/w/s!AbCdEf",
    "http://sharepoint.com/x.docx",
  ];
  for (const u of yes) assert.equal(looksLikeDocumentLink(u), true, u);

  const no = [
    "https://example.com/page",
    "https://graph.microsoft.com/v1.0/me",
    "not a url",
    "ftp://sharepoint.com/x.docx",
    "https://sharepoint.com.evil.example/x.docx",
    "",
  ];
  for (const u of no) assert.equal(looksLikeDocumentLink(u), false, u);
});

test("a Teams file link resolves to the SharePoint document it points at", () => {
  const teams = "https://teams.microsoft.com/l/file/0F0E0A1B?threadId=19%3Aabc&objectUrl=https%3A%2F%2Fcontoso.sharepoint.com%2Fsites%2FX%2FSpec.docx&tenantId=x";
  assert.equal(shareLinkFor(teams), "https://contoso.sharepoint.com/sites/X/Spec.docx");
  const plain = "https://contoso.sharepoint.com/sites/X/Spec.docx";
  assert.equal(shareLinkFor(plain), plain);
  assert.equal(shareLinkFor("nonsense"), "nonsense");
});

test("names other document services instead of silently pretending", () => {
  assert.equal(otherDocumentService("https://docs.google.com/document/d/abc"), "Google Docs/Sheets/Slides");
  assert.equal(otherDocumentService("https://www.dropbox.com/s/xyz/file.docx"), "Dropbox");
  assert.equal(otherDocumentService("https://example.com/x"), "");
});

test("extension parsing", () => {
  assert.equal(extOf("Spec.docx"), "docx");
  assert.equal(extOf("no-extension"), "");
  assert.equal(extOf("archive.TAR.GZ"), "gz");
  assert.equal(extOf(""), "");
});

test("unconfigured bridge explains what an admin must set (never a sign-in page)", () => {
  const cfg = { tenant: "", clientId: "", secret: "", certPath: "", certPass: "", configured: false, missing: ["M365_GRAPH_CLIENT_ID"], mode: "none" };
  const hint = unconfiguredHint(cfg);
  assert.match(hint, /M365_GRAPH_CLIENT_ID/);
  assert.match(hint, /DOCUMENT-LINKS\.md/);
  assert.match(hint, /web_fetch/);
});

test("a document link on an unconfigured bridge refuses honestly", async () => {
  const saved = { ...process.env };
  for (const k of ["M365_GRAPH_TENANT", "M365_GRAPH_CLIENT_ID", "M365_GRAPH_CLIENT_SECRET", "M365_GRAPH_CERT_PATH", "M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"]) delete process.env[k];
  try {
    assert.equal(graphConfig().configured, false);
    const r = await readDocumentText("https://blueucadmin.sharepoint.com/:w:/g/ABC", { anonymous: false });
    assert.equal(r.ok, false);
    assert.equal(r.unconfigured, true);
    assert.match(r.error, /not configured/);
    assert.match(r.hint, /Anyone with the link/);

    const notDoc = await readDocumentText("https://example.com/");
    assert.equal(notDoc.ok, false);
    assert.match(notDoc.error, /not a SharePoint/);

    const g = await readDocumentText("https://docs.google.com/document/d/abc");
    assert.equal(g.ok, false);
    assert.match(g.error, /Google Docs/);

    assert.equal((await readDocumentText("nonsense")).ok, false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("config is described without leaking the secret", () => {
  const d = describeConfig();
  assert.equal(typeof d.configured, "boolean");
  assert.ok(!JSON.stringify(d).includes("secret="));
  assert.ok(!("secret" in d));
});

// The root cause of "the bot can't read a PUBLIC SharePoint link": the first redirect sets a guest
// cookie the next hop requires. A fake SharePoint that enforces exactly that.
function fakeSharePoint({ publicLink = true, file = Buffer.from("hello from the SOW") } = {}) {
  const calls = [];
  const resp = (status, headers = {}, body = "") => new Response(body, { status, headers });
  const impl = async (url, init) => {
    calls.push({ url, cookie: init?.headers?.Cookie || "" });
    const u = new URL(url);
    if (u.pathname.startsWith("/:w:/g/")) {
      assert.equal(u.searchParams.get("download"), "1");
      if (!publicLink) return resp(302, { location: "https://login.microsoftonline.com/x/oauth2/authorize" });
      const h = new Headers({ location: "/Shared%20Documents/SOW.docx?ga=1" });
      h.append("set-cookie", "FedAuth=guest123; path=/; secure; HttpOnly");
      return new Response("", { status: 302, headers: h });
    }
    if (u.pathname === "/Shared%20Documents/SOW.docx") {
      if (!/FedAuth=guest123/.test(init?.headers?.Cookie || "")) {
        return resp(302, { location: "https://tenant.sharepoint.com/_layouts/15/Authenticate.aspx?Source=x" });
      }
      return resp(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="SOW.txt"' }, file);
    }
    return resp(404);
  };
  return { impl, calls };
}

test("public link: download=1 + the guest cookie carried to the next hop", async () => {
  const sp = fakeSharePoint();
  const r = await anonymousDownload("https://tenant.sharepoint.com/:w:/g/TOKEN?e=abc", { fetchImpl: sp.impl });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.buf.toString(), "hello from the SOW");
  assert.equal(r.name, "SOW.txt");
  assert.match(sp.calls[1].cookie, /FedAuth=guest123/);
  assert.equal(new URL(withDownloadFlag("https://t.sharepoint.com/:w:/g/X?e=1")).searchParams.get("download"), "1");
});

test("private link: stops at the sign-in hop and says the link is not public", async () => {
  const sp = fakeSharePoint({ publicLink: false });
  const r = await anonymousDownload("https://tenant.sharepoint.com/:w:/g/TOKEN", { fetchImpl: sp.impl });
  assert.equal(r.ok, false);
  assert.equal(r.signIn, true);
  assert.equal(sp.calls.length, 1, "never requests the login page itself");
});

test("readDocumentText reads a public link end to end without any Graph config", async () => {
  const sp = fakeSharePoint();
  const r = await readDocumentText("https://tenant.sharepoint.com/:w:/g/TOKEN", { fetchImpl: sp.impl, cfg: { configured: false, missing: ["x"] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, "public-link");
  assert.match(r.text, /hello from the SOW/);
});

// Office files are ZIPs of XML. Build real ones with Python's zipfile (deflate), as Word does.
function makeZip(entries) {
  const out = `/tmp/doclink-test-${process.pid}-${Math.random().toString(36).slice(2)}.zip`;
  execFileSync("python3", ["-c", `import zipfile,json,sys
e=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:
    [z.writestr(k,v) for k,v in e.items()]`, out, JSON.stringify(entries)]);
  const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
}

test("Word: paragraphs, tabs, tables, entities; tracked deletions and field codes dropped", async () => {
  const doc = '<w:document><w:body><w:p><w:r><w:t>Help Desk</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Rate:</w:t><w:tab/><w:t>$125 &amp; up</w:t></w:r></w:p>' +
    '<w:p><w:del><w:r><w:delText>OLD TEXT</w:delText></w:r></w:del><w:r><w:instrText>MERGEFIELD x</w:instrText><w:t>kept</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const buf = makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": doc });
  assert.equal(unzipEntries(buf).has("word/document.xml"), true);
  const r = await extractFromBuffer(buf, "SOW.dotx");
  assert.equal(r.kind, "word");
  assert.match(r.text, /Help Desk/);
  assert.match(r.text, /Rate:\t\$125 & up/);
  assert.match(r.text, /kept/);
  assert.doesNotMatch(r.text, /OLD TEXT|MERGEFIELD/);
  assert.match(r.text, /A1/); assert.match(r.text, /B1/);
});

test("Excel and PowerPoint text", async () => {
  const xlsx = makeZip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Pricing" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Users</t></si><si><t>Rate</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>8</v></c><c r="B2"><v>125</v></c></row></sheetData></worksheet>',
  });
  const x = await extractFromBuffer(xlsx, "p.xlsx");
  assert.equal(x.kind, "excel");
  assert.match(x.text, /sheet: Pricing/);
  assert.match(x.text, /Users\tRate\n8\t125/);

  const pptx = makeZip({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
  });
  const p = await extractFromBuffer(pptx, "deck.pptx");
  assert.equal(p.kind, "powerpoint");
  assert.ok(p.text.indexOf("First") < p.text.indexOf("Second"), "slides in numeric order");
});

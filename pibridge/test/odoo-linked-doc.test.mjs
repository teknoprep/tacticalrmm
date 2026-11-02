import assert from "node:assert/strict";
import test from "node:test";
import { withLinkedDocuments } from "../src/odoo-chat.js";

// The ERP chat has no tools by design; the bridge reads M365 links and appends the text.
const fakeRead = async (url) => url.includes("bad")
  ? { ok: false, error: "SharePoint asked for a sign-in", hint: "ask for the file" }
  : { ok: true, name: "SOW.dotx", totalChars: 11, source: "public-link", text: "SOW.dotx — Help Desk scope" };

test("appends linked M365 documents, leaves ordinary links and the original words alone", async () => {
  const msg = "SOW here → https://t.sharepoint.com/:w:/g/ABC?e=x. and https://example.com/page";
  const r = await withLinkedDocuments(msg, { read: fakeRead, logFn: () => {} });
  assert.ok(r.content.startsWith(msg), "technician's words first, unchanged");
  assert.match(r.content, /\[\[linked-document: SOW\.dotx \| https:\/\/t\.sharepoint\.com\/:w:\/g\/ABC\?e=x\]\]/);
  assert.match(r.content, /Help Desk scope/);
  assert.equal(r.docs.length, 1, "example.com is not a document link");
});

test("an unreadable link is reported with its reason, not silently dropped", async () => {
  const r = await withLinkedDocuments("https://t.sharepoint.com/bad.docx", { read: fakeRead, logFn: () => {} });
  assert.match(r.content, /linked-document-unreadable/);
  assert.match(r.content, /asked for a sign-in/);
  assert.match(r.content, /ask for the file/);
});

test("no links: message passes through untouched; at most 3 documents per message", async () => {
  assert.equal((await withLinkedDocuments("just text", { read: fakeRead })).content, "just text");
  const many = [1, 2, 3, 4, 5].map((i) => `https://t.sharepoint.com/d${i}.docx`).join(" ");
  assert.equal((await withLinkedDocuments(many, { read: fakeRead, logFn: () => {} })).docs.length, 3);
});

// CLOUD ADMIN PORTALS MUST GO THROUGH THE CLI (owner, 2026-09-27).
//
// TICKET/61884 was "grant David access to Anna Marie's mailbox". The model spent ~12 minutes
// driving the Exchange admin center through the Operator desktop: typing into a user picker,
// blind-clicking result rows it could not read, and burning turns on `Start-Sleep -Seconds 10;
// "wait done"` to let the page settle. It then refused to make the final click because a
// mis-click would have granted mailbox access to the wrong person - good judgement, wrong route.
// The job is two cmdlets:
//   Add-MailboxPermission   -Identity <mailbox> -User <person> -AccessRights FullAccess
//   Add-RecipientPermission -Identity <mailbox> -Trustee <person> -AccessRights SendAs
// and run_script_with_credential had ALREADY worked on that same ticket (it ran as
// b***n@GevurtzFurnitureInc.onmicrosoft.com), so no human was needed at all.
//
// The old guard only blocked the desktop when the URL host matched an RMM AGENT, so cloud
// portals - which no agent serves - passed straight through to GUI automation.
import test from "node:test";
import assert from "node:assert/strict";
import { agentFirstDesktop, CLOUD_ADMIN_PORTAL, cloudPortalMessage } from "../src/tools.js";

const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
const openUrlTool = () => ({
  name: "operator_desktop_open_url",
  execute: async () => text("OPENED THE PAGE (should not happen in these tests)"),
});

/** Run the guard around a portal-open call and return what the model would see. */
async function tryOpen(url, techTurns = null) {
  const tool = openUrlTool();
  agentFirstDesktop([tool], { techTurns, text });
  const res = await tool.execute("id", { url });
  return res.content.map((c) => c.text).join("\n");
}

test("the admin portals are recognised, and the pages that must stay allowed are not", () => {
  for (const h of [
    "admin.exchange.microsoft.com", "admin.microsoft.com", "entra.microsoft.com",
    "admin.teams.microsoft.com", "portal.azure.com", "security.microsoft.com",
    "purview.microsoft.com", "admin.cloud.microsoft", "admin.office.com",
  ]) assert.ok(CLOUD_ADMIN_PORTAL.test(h), `${h} should be blocked`);

  for (const h of [
    "mysignins.microsoft.com",      // the TOTP enrolment page still reads a secret off-screen
    "login.microsoftonline.com",    // sign-in itself
    "mail.gei.local", "portal.acme.com", "pve01.sunnydellfood.local",
  ]) assert.ok(!CLOUD_ADMIN_PORTAL.test(h), `${h} must NOT be blocked by this rule`);
});

test("opening a cloud admin portal is refused and the refusal carries the working recipe", async () => {
  const msg = await tryOpen("https://admin.exchange.microsoft.com/#/mailboxes/anna");
  assert.match(msg, /BLOCKED/);
  assert.match(msg, /cloud admin portal/);
  assert.match(msg, /run_script_with_credential/);
  assert.match(msg, /Connect-ExchangeOnline/);
  assert.match(msg, /Connect-MgGraph/);
  assert.match(msg, /PI_USER/);
  assert.doesNotMatch(msg, /OPENED THE PAGE/, "the page must not be opened at all");
});

test("a technician who asks for the browser still gets it", async () => {
  const msg = await tryOpen("https://admin.exchange.microsoft.com/", [{ text: "just use the browser for this one" }]);
  assert.match(msg, /OPENED THE PAGE/);
});

test("a website-only vendor console is not affected by this rule", async () => {
  // not a Microsoft admin portal: the guard falls through to its RMM-agent check, and with no
  // agent match the call proceeds.
  const msg = await tryOpen("https://portal.somevendor.example.com/admin");
  assert.match(msg, /OPENED THE PAGE/);
});

test("the refusal names the alternative as the FIRST choice, not an afterthought", () => {
  const m = cloudPortalMessage("admin.exchange.microsoft.com");
  assert.ok(m.indexOf("run_script_with_credential") < m.indexOf("website-only vendor console"),
    "the CLI route is described before the desktop fallback");
});

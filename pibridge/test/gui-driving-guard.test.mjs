// A second, unguarded desktop-control plane.
//
// TICKET/60427, 2026-08-25. Needing to complete a device-code sign-in, the model did not
// use the Operator - it wrote its own UI Automation and SendKeys PowerShell and pushed it
// through run_device_command. None of the Operator's rules apply on that route: no
// InPrivate enforcement, no privacy verification, no focus guard, no screenshot for the
// technician, no audit line.
//
// The result was exactly what those guards prevent. It opened the device-login page in the
// workstation's OWN signed-in Edge profile ("in blueucadmin session"), Microsoft matched
// the code against the wrong tenant (AADSTS50034: the account does not exist in that
// directory), it retried, and the account locked (AADSTS50053 x4). After that nothing
// worked at all - which is the state the owner reported.
import { test } from "node:test";
import assert from "node:assert/strict";

import { terminalAuthFailure } from "../src/tools.js";

// Mirrors GUI_DRIVING in tools.js. Kept here so the patterns are asserted against REAL
// command text taken from the failed session rather than against themselves.
const GUI_DRIVING = [
  /UIAutomationClient|UIAutomationTypes|\bAutomationElement\b/i,
  /System\.Windows\.Forms.*\bSendKeys\b|\[System\.Windows\.Forms\.SendKeys\]|SendKeys\]::Send/i,
  /\bSendWait\b/i,
  /user32\.dll.*\b(SetForegroundWindow|keybd_event|mouse_event|SendInput|SetCursorPos)\b/is,
  /\bSetForegroundWindow\b|\bkeybd_event\b|\bmouse_event\b|\bSendInput\b/i,
  /Add-Type[^\n]*PresentationCore|Add-Type[^\n]*WindowsBase/i,
];
const drives = (cmd) => GUI_DRIVING.some((re) => re.test(cmd));

test("the actual commands from the failed session are recognised as driving the screen", () => {
  // Verbatim openings of the run_device_command calls in session 01a03989.
  for (const cmd of [
    "$script=@'\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes",
    "Add-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n$root=[System.Windows.Automation.AutomationElement]::RootElement",
    "[System.Windows.Forms.SendKeys]::SendWait('FCPMNWVMD')",
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\"{ENTER}\")",
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\' -Name W -Namespace P',
  ]) {
    assert.equal(drives(cmd), true, `should be blocked on an Operator box:\n${cmd.slice(0, 70)}`);
  }
});

test("ordinary administration is not caught", () => {
  // The guard must not turn into a reason to stop using the shell for shell work.
  for (const cmd of [
    "Get-Service spooler | Restart-Service",
    "Get-MgUser -UserId chris@blueuc.com | Select DisplayName",
    "Get-CsOnlinePSTNGateway | Format-List",
    "systemctl status freeswitch",
    "Get-Process msedge | Where-Object { $_.MainWindowHandle -ne 0 }",
    "Add-Type -AssemblyName System.Web; [System.Web.Security.Membership]::GeneratePassword(16,3)",
  ]) {
    assert.equal(drives(cmd), false, `should NOT be blocked:\n${cmd.slice(0, 70)}`);
  }
});

test("the refusal only applies to machines the Operator owns", () => {
  // A machine with no Operator has no better route, so refusing would just remove a
  // capability and leave nothing in its place.
  const operatorAgentIds = new Set(["MCincBNurhcXlhnlcrnMhNHVczeObSyYMZskMDmm"]);
  const uia = "Add-Type -AssemblyName UIAutomationClient";
  assert.equal(drives(uia) && operatorAgentIds.has("MCincBNurhcXlhnlcrnMhNHVczeObSyYMZskMDmm"), true);
  assert.equal(drives(uia) && operatorAgentIds.has("DAmsYZMxHBXYqiVuSDTGhREtnruwkouCZEbSIvHb"), false,
    "the Linux PBX box is not an Operator workstation");
});

// ---- the retry loop that locked the account ---------------------------------------

test("Azure's refusals are recognised as terminal", () => {
  const real =
    "CONNECT_FAIL System.AggregateException One or more errors occurred. " +
    "(AADSTS50053: The account is locked, you've tried to sign in too many times with an " +
    "incorrect user ID or password. Trace ID: 8478a881-a75b-4c3f-bd64-d3230a229a00)";
  assert.equal(terminalAuthFailure(real), "AADSTS50053");

  const wrongTenant =
    "CONNECT_FAIL (AADSTS50034: The user account {EUII Hidden} does not exist in the " +
    "blueucadmin.onmicrosoft.com directory.)";
  assert.equal(terminalAuthFailure(wrongTenant), "AADSTS50034");

  assert.equal(terminalAuthFailure("AADSTS50126: Error validating credentials"), "AADSTS50126");
});

test("a transient or unrelated failure is not marked terminal", () => {
  // Retrying these is legitimate; the guard must not turn every hiccup into a full stop.
  assert.equal(terminalAuthFailure("authorization_pending"), null);
  assert.equal(terminalAuthFailure("The remote server returned an error: (503)"), null);
  assert.equal(terminalAuthFailure("CONNECT_OK 2026-08-25T17:52:20"), null);
  assert.equal(terminalAuthFailure(""), null);
  assert.equal(terminalAuthFailure(null), null);
});

test("a successful connect is never flagged", () => {
  const ok =
    "chris@blueuc.com AzureCloud 965b0bfa-d4f4-4ebc-a69b-2bad1f0157ca\nCONNECT_OK\n" +
    "TENANT=BlueCloud Consultants";
  assert.equal(terminalAuthFailure(ok), null);
});

// ---- launching a browser behind the Operator's back --------------------------------
// The first version of this guard only caught hand-rolled UI Automation and missed the
// commonest case entirely. In TICKET/60427 the model opened the sign-in page five times
// with `Start-Process $edge -ArgumentList '--new-window <url>'` - no UIA, no SendKeys,
// just a launch - and NONE of the five passed --inprivate. Every one opened an ordinary
// window in the workstation's own signed-in profile. That is the "it keeps using a regular
// browser window" the owner reported.

const BROWSER_LAUNCH = [
  /\bStart-Process\b[^\n]{0,200}?(msedge|chrome|firefox|iexplore|\$edge|\$browser)/i,
  /\b(msedge|chrome|firefox)\.exe\b[^\n]{0,120}https?:\/\//i,
  /^\s*start\s+(msedge|chrome|firefox|microsoft-edge:)/im,
  /\bmicrosoft-edge:https?:\/\//i,
  /\[System\.Diagnostics\.Process\]::Start\([^)]{0,80}(msedge|chrome|firefox)/i,
  /\b(Invoke-Item|ii|explorer(\.exe)?)\s+["']?https?:\/\//i,
];
const launches = (cmd) => BROWSER_LAUNCH.some((re) => re.test(cmd));

test("the five real launches from the failed session are caught", () => {
  for (const cmd of [
    "Start-Process $edge -ArgumentList '--new-window https://login.microsoft.com/device'",
    "Start-Process `$edge -ArgumentList '--new-window https://login.microsoftonline.com/common/oauth2/deviceauth?otc=$code'",
    "Start-Process $edge -ArgumentList '--new-window https://login.microsoftonline.com/common/oauth2/deviceauth?otc=A87F4L94D'",
    "Start-Process msedge ",
    "Start-Process 'msedge.exe' -ArgumentList '--new-window','https://portal.office.com'",
  ]) {
    assert.equal(launches(cmd), true, `should be blocked:\n${cmd.slice(0, 80)}`);
  }
});

test("none of those five asked for InPrivate - which is the whole point", () => {
  const real = "Start-Process $edge -ArgumentList '--new-window https://login.microsoft.com/device'";
  assert.equal(/inprivate/i.test(real), false,
    "a shell launch has no InPrivate enforcement and nothing verifies the window it got");
});

test("other ways to open a URL are caught too", () => {
  for (const cmd of [
    "start msedge https://portal.office.com",
    "explorer.exe https://portal.office.com",
    "Invoke-Item 'https://admin.microsoft.com'",
    "[System.Diagnostics.Process]::Start('msedge','https://x.test')",
    "microsoft-edge:https://portal.office.com",
  ]) {
    assert.equal(launches(cmd), true, `should be blocked:\n${cmd}`);
  }
});

test("inspecting or stopping a browser is NOT blocked", () => {
  // Narrow on purpose: launching is what puts a customer session in the wrong profile.
  // Reading and killing do not, and blocking them would remove real diagnostics.
  for (const cmd of [
    "Get-Process msedge | Where-Object { $_.MainWindowHandle -ne 0 }",
    "Stop-Process -Name msedge -Force",
    "Get-Process msedge -ErrorAction SilentlyContinue | Select-Object MainWindowTitle",
    "Test-Path 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'",
    "Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'",
  ]) {
    assert.equal(launches(cmd), false, `should NOT be blocked:\n${cmd}`);
  }
});

test("a browser launch on a NON-Operator machine is still allowed", () => {
  // The Linux PBX box has no Operator and no better route to point at.
  const operatorAgentIds = new Set(["MCincBNurhcXlhnlcrnMhNHVczeObSyYMZskMDmm"]);
  const cmd = "Start-Process msedge https://x.test";
  assert.equal(launches(cmd) && operatorAgentIds.has("DAmsYZMxHBXYqiVuSDTGhREtnruwkouCZEbSIvHb"), false);
});

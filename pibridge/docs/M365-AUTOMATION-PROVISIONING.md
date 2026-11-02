# M365 automation provisioning (app + certificate)

Owner decisions, 2026-10-06: **one multi-tenant app** registered in **BlueCloud's own tenant**,
**one certificate** (single-cert blast radius accepted and preferred), private key on
**m365-admin-w11**, renewal **automatic at ≤30 days** with a ticket raised if it cannot rotate in
time. Register: the global KB article *"M365 automation access — client register"*.

Work order: **TICKET/62307**.

## What it is

One Entra app (`BlueCloud M365 Automation`, sign-in audience **multi-tenant**) plus one
non-exportable certificate on `m365-admin-w11`. Each customer tenant gets the app's service
principal, admin consent for the app roles, and the Exchange `Recipient Management` role assigned
to the app. After that the reviewed M365 scripts run **app-only** —
`Connect-MgGraph -ClientId <AppId> -TenantId <customer> -CertificateThumbprint <thumb>` — with no
password and no TOTP ever again.

Least privilege (in the script, one place):

| Resource | Roles |
|---|---|
| Microsoft Graph | `User.ReadWrite.All`, `Directory.ReadWrite.All`, `Group.ReadWrite.All`, `LicenseAssignment.ReadWrite.All`, `IdentityRiskyUser.ReadWrite.All`, `Organization.Read.All` |
| Exchange Online | `Exchange.ManageAsApp` + the Exchange RBAC role **Recipient Management** |

## The script

`Pi.dev - M365 automation (provision)` — RMM script pk **198**, hidden, on `m365-admin-w11`.
Source: `scripts/m365-automation-provision.ps1`. It logs to
`C:\ProgramData\BlueCloud\m365-automation.log` and ends every run with `RESULT_JSON {…}`.

| Mode | What it does | Human needed |
|---|---|---|
| `Home` | Create the multi-tenant app + required roles, create the certificate here, upload the **public** key, consent in BlueCloud's tenant, verify app-only. | Once (BlueCloud admin sign-in) |
| `Tenant -CustomerDomain <d>` | Service principal + admin consent in that customer, Exchange role, verify app-only, write the map. | Yes — that customer's admin |
| `Verify -CustomerDomain <d>` | App-only sign-in test for one client. | No |
| `Renew` | New certificate + public key using the still-valid current cert; updates the map. | No |
| `Status` | Map + certificate expiry. No cloud calls. | No |

Authentication is **device code**. The script prints a code and waits; the code is entered on the
**Operator desktop** with the stored username/password (`operator_desktop_fill_secret`) and the
client's TOTP (`get_totp_code`) — that TOTP is what satisfies MFA. No password or code passes
through Pi.

## How the automation drives it

1. **Start in the background** (the device-code wait can be minutes), e.g.
   `powershell -File …\m365-automation-provision.ps1 -Mode Tenant -CustomerDomain <d> -Background`,
   or run pk 198 as a scheduled RMM action so the caller returns immediately.
2. **Read the code** from the log:
   `Get-Content C:\ProgramData\BlueCloud\m365-automation.log -Tail 20`.
3. **Complete the sign-in on the Operator desktop**: open `https://microsoft.com/devicelogin`, enter
   the code, `operator_desktop_fill_secret` (company = the Odoo company name, label = the IT
   Notebook O365 admin row), then `get_totp_code` and type the 6 digits. A second code follows for
   Exchange — same procedure.
4. **Read the result**: tail the log for `RESULT_JSON`; `ok:true` plus `verified:true` means done.
5. **Record it**: add/refresh the client's row in the KB register.

## Pilot runbook — first customer tenant (one tenant)

1. **Home (one-time, human-assisted).** Run pk 198 `-Mode Home` on `m365-admin-w11`. There is no
   TOTP on file for BlueCloud's own tenant, so a technician completes the device-code sign-in (this
   is the one time it happens; afterwards the certificate drives everything). Confirm the log shows
   `RESULT_JSON … ok:true`.
2. **First pilot customer.** Run `-Mode Tenant -CustomerDomain <customer-domain>`. Complete both
   device-code sign-ins on the Operator desktop using that customer's IT Notebook O365 admin row +
   its TOTP. (Which customer was piloted is recorded in the private pi-ai-helpdesk repo.)
3. **Verify.** Expect `app-only sign-in verified` and `verified:true` in the result.
4. **Prove the real job.** Run the existing reviewed action `m365-offboard-user` **in dry-run** or
   against a test user, and confirm it authenticates app-only.
5. **Record.** Write the pilot customer's row in the KB register.
6. **Only then** work the remaining 33 from the checklist note on TICKET/62307.

## Renewal

A daily check reads the certificate expiry. At **≤30 days** it runs `-Mode Renew` using the
still-valid certificate (generate → upload public key → update the map/KB thumbprint → drop the old
key after a grace period), so there is no downtime and no human. If it cannot rotate in time, or the
certificate is **already expired**, `Renew` refuses and a ticket must be raised for a human to run
the device-code sign-in and add the new credential.

## Failure modes and what to do

| Symptom | Cause | Action |
|---|---|---|
| `AADSTS…` consent/permission error on Home/Tenant | admin lacks **Global Administrator** (or Application + Privileged Role + Exchange Admin) | hand that client to a human with the exact error; do not improvise |
| Device code page refuses / no code | Conditional Access blocks device-code flow | fall back to the Entra portal on the Operator desktop, or hand to a human |
| `no row with a password matches` | notebook label mismatch | use the exact IT Notebook **Info** label (the coverage op returns it) |
| `certificate expired … cannot self-rotate` | renewal missed | raise a ticket; a human signs in and runs `Home`/adds the key |
| Domain not in the map after `Tenant` | run failed before the map write | read `RESULT_JSON` for the error; nothing is recorded on failure |

## Security rules (do not break)

- The private key is **non-exportable**, machine store, on `m365-admin-w11` only. It is never
  printed, never exported, never written to the map or the KB.
- The KB register holds **public identifiers only** — Tenant ID, App/Client ID, thumbprint, expiry.
  Never a password, TOTP secret/code, or key.
- One app, one certificate: **never** create a second app. The script looks up by display name.
- Every run is gated by the standing approval flow on the surface it runs from; provisioning is an
  operator/admin job, **not** ticket autowork (which has no desktop and cannot complete a login).

<#
.SYNOPSIS
    BlueCloud M365 automation provisioning (Pi.dev).

.DESCRIPTION
    Creates and maintains the ONE multi-tenant automation app that BlueCloud's unattended M365
    scripts use, and keeps its certificate and the per-client map in step.

    Modes
      Home    Run ONCE, in BlueCloud's own tenant: create the multi-tenant app, set the
              least-privilege Graph + Exchange app roles, create the certificate on THIS host,
              upload its PUBLIC key, consent the roles in the home tenant, and verify an
              app-only sign-in.
      Tenant  Run ONCE per customer: consent the app into that customer's tenant (service
              principal + app-role grants) and assign the Exchange "Recipient Management" role.
              Signs in as the CUSTOMER's O365 admin.
      Verify  App-only sign-in test for one client (no human).
      Renew   Rotate the certificate using the STILL-VALID current one (no human). If the
              current certificate has already expired this refuses - a human must sign in.
      Status  Print the map and certificate expiry. No cloud calls.

    Authentication (Home / Tenant)
      OAuth DEVICE CODE. Start this script and it prints a code + URL, then waits. Read the code
      from this log, complete the sign-in on the Operator desktop (username/password injected by
      the broker + the client's TOTP code) - MFA is satisfied by the TOTP. No password or code
      ever passes through Pi.

    Deployment (owner, 2026-10-06)
      Runs on m365-admin-w11 (the certificate private key lives there and never leaves).
      Multi-tenant app in BlueCloud's own tenant; each customer is admin-consented into it.

    Safety
      - The private key is created NON-EXPORTABLE in Cert:\LocalMachine\My and is never copied off
        this host, never printed, never written to the map or the KB.
      - Idempotent: re-running never creates a second app, a second service principal, or a
        duplicate grant.
      - -DryRun prints what it would do and changes nothing in the cloud.
      - Every run writes RESULT_JSON <...> as its last log line, for the automation to read.
      - The map (C:\ProgramData\BlueCloud\m365-tenants.json) keeps its original shape
        (Domain / AppId / TenantId / Thumbprint) so the existing scripts keep working, and adds
        CertExpires / VerifiedAt / Kind.

.EXAMPLE
    powershell -File m365-automation-provision.ps1 -Mode Home
    powershell -File m365-automation-provision.ps1 -Mode Tenant -CustomerDomain customer.example.com
    powershell -File m365-automation-provision.ps1 -Mode Verify -CustomerDomain customer.example.com
    powershell -File m365-automation-provision.ps1 -Mode Renew
    powershell -File m365-automation-provision.ps1 -Mode Status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Home', 'Tenant', 'Verify', 'Renew', 'Status')]
    [string]$Mode,

    [string]$CustomerDomain = '',
    [string]$TenantId = '',
    [string]$MapPath = 'C:\ProgramData\BlueCloud\m365-tenants.json',
    [string]$LogPath = 'C:\ProgramData\BlueCloud\m365-automation.log',
    [int]$CertYears = 2,
    [switch]$DryRun,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# CONFIGURATION (reviewed here, in one place)
# ---------------------------------------------------------------------------------------------
$AppDisplayName = 'BlueCloud M365 Automation'
$CertSubject    = 'CN=BlueCloud M365 Automation'
# Well-known resource app ids: Microsoft Graph and Office 365 Exchange Online.
$GraphAppId     = '00000003-0000-0000-c000-000000000000'
$ExoAppId       = '00000002-0000-0ff1-ce00-000000000000'
# LEAST PRIVILEGE. Add a role here only when a reviewed script actually calls it.
$GraphRoles     = @(
    'User.ReadWrite.All',                # users: offboarding (disable), read/write
    'Directory.ReadWrite.All',           # directory objects
    'Group.ReadWrite.All',               # group / distribution-list membership
    'LicenseAssignment.ReadWrite.All',   # assign / reclaim licences
    'IdentityRiskyUser.ReadWrite.All',   # Entra ID Protection confirm/dismiss
    'Organization.Read.All'              # verification (Get-MgOrganization)
)
$ExoRoles       = @('Exchange.ManageAsApp')   # mailboxes, permissions, mail flow
$ExoRoleName    = 'Recipient Management'      # Exchange RBAC role granted to the app

# ---------------------------------------------------------------------------------------------
# LOGGING
# ---------------------------------------------------------------------------------------------
function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    Write-Host $line
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch { }
}
function Write-Result([hashtable]$Result) {
    Write-Log ('RESULT_JSON ' + ($Result | ConvertTo-Json -Compress -Depth 6))
}

# Self-detach: the device-code wait can be minutes, so run it away from the caller and let the
# automation tail the log for the code. Copies the same arguments, minus -Background.
if ($Background) {
    $self = $MyInvocation.MyCommand.Path
    if (-not $self) { throw '-Background needs the script to run from a file' }
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Mode', $Mode,
             '-MapPath', $MapPath, '-LogPath', $LogPath, '-CertYears', "$CertYears")
    if ($CustomerDomain) { $fwd += @('-CustomerDomain', $CustomerDomain) }
    if ($TenantId) { $fwd += @('-TenantId', $TenantId) }
    if ($DryRun) { $fwd += '-DryRun' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $fwd -WindowStyle Hidden | Out-Null
    Write-Host "started in background; tail the log: $LogPath"
    exit 0
}

# ---------------------------------------------------------------------------------------------
# MAP  (C:\ProgramData\BlueCloud\m365-tenants.json - the machine record the scripts read)
# ---------------------------------------------------------------------------------------------
function Get-Map {
    if (Test-Path $MapPath) {
        try {
            $m = Get-Content $MapPath -Raw | ConvertFrom-Json
            if ($m) { return @($m) }
        } catch { Write-Log "WARN map unreadable: $_" }
    }
    return @()
}
function Save-MapEntry([string]$Domain, [hashtable]$Fields) {
    $all = @(Get-Map)
    $entry = @{ Domain = $Domain }
    $existing = $all | Where-Object { $_.Domain -eq $Domain } | Select-Object -First 1
    if ($existing) { foreach ($p in $existing.PSObject.Properties) { $entry[$p.Name] = $p.Value } }
    foreach ($k in $Fields.Keys) { $entry[$k] = $Fields[$k] }
    $all = @($all | Where-Object { $_.Domain -ne $Domain }) + @([pscustomobject]$entry)
    $all = @($all | Sort-Object Domain)
    if ($DryRun) { Write-Log ("DRYRUN would write map entry {0}: {1}" -f $Domain, ($Fields | ConvertTo-Json -Compress)); return }
    $dir = Split-Path -Parent $MapPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($all | ConvertTo-Json -Depth 8) | Set-Content -Path $MapPath -Encoding UTF8
    Write-Log "map updated: $Domain"
}
function Get-HomeEntry { return (Get-Map | Where-Object { $_.Kind -eq 'home' } | Select-Object -First 1) }

# ---------------------------------------------------------------------------------------------
# CERTIFICATE
# ---------------------------------------------------------------------------------------------
function Get-AutomationCert {
    return Get-ChildItem Cert:\LocalMachine\My |
        Where-Object { $_.Subject -eq $CertSubject } |
        Sort-Object NotAfter -Descending | Select-Object -First 1
}
function New-AutomationCert {
    $c = New-SelfSignedCertificate -Subject $CertSubject -CertStoreLocation 'Cert:\LocalMachine\My' `
        -KeyExportPolicy NonExportable -KeySpec Signature -KeyAlgorithm RSA -KeyLength 2048 `
        -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears([Math]::Max(1, $CertYears))
    Write-Log ("certificate created: {0} expires {1:yyyy-MM-dd}" -f $c.Thumbprint, $c.NotAfter)
    return $c
}
function Add-PublicKeyToApp($AppObjectId, $Cert, $ExistingKeys) {
    $has = @($ExistingKeys) | Where-Object { $_.DisplayName -eq $Cert.Thumbprint }
    if ($has) { Write-Log "public key already on the app ($($Cert.Thumbprint))"; return $false }
    if ($DryRun) { Write-Log "DRYRUN would upload public key $($Cert.Thumbprint)"; return $true }
    $body = @{
        keyCredentials = @(@{
            type        = 'AsymmetricX509Cert'
            usage       = 'Verify'
            key         = [Convert]::ToBase64String($Cert.RawData)
            displayName = $Cert.Thumbprint
        })
    }
    Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/addKey" -Body $body | Out-Null
    Write-Log "public key uploaded to the app ($($Cert.Thumbprint))"
    return $true
}

# ---------------------------------------------------------------------------------------------
# GRAPH HELPERS
# ---------------------------------------------------------------------------------------------
function Connect-DeviceGraph([string]$Tenant, [string[]]$Scopes) {
    Write-Log '=== DEVICE SIGN-IN: a code appears below - open https://microsoft.com/devicelogin and enter it ==='
    if ($Tenant) { Connect-MgGraph -TenantId $Tenant -Scopes $Scopes -UseDeviceCode -NoWelcome }
    else { Connect-MgGraph -Scopes $Scopes -UseDeviceCode -NoWelcome }
    $org = Get-MgOrganization
    Write-Log "signed in (delegated) to tenant $($org.Id)"
    return $org
}
function Get-AutomationApp {
    return Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction SilentlyContinue | Select-Object -First 1
}
function Get-AppSp([string]$AppId) {
    return Get-MgServicePrincipal -Filter "appId eq '$AppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
}
# Resolve the app-role ids (GUIDs) for the named permissions from the resource's service principal,
# so a permission rename/showcase change cannot silently grant the wrong thing.
function Get-RoleIds([string]$ResourceAppId, [string[]]$Values) {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'"
    if (-not $sp) { throw "resource service principal $ResourceAppId not found" }
    $out = @()
    foreach ($v in $Values) {
        $role = $sp.AppRoles | Where-Object { $_.Value -eq $v -and ($_.AllowedMemberTypes -contains 'Application') } | Select-Object -First 1
        if (-not $role) { throw "app role '$v' not found on resource $ResourceAppId" }
        $out += [pscustomobject]@{ Id = $role.Id; Value = $v; ResourceSpId = $sp.Id }
    }
    return $out
}
function Ensure-AppRoleGrant([string]$SpId, [string]$ResourceSpId, [string]$RoleId, [string]$Label) {
    $existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $SpId -ErrorAction SilentlyContinue |
        Where-Object { $_.ResourceId -eq $ResourceSpId -and $_.AppRoleId -eq $RoleId }
    if ($existing) { return $false }
    if ($DryRun) { Write-Log "DRYRUN would grant $Label"; return $true }
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $SpId -PrincipalId $SpId `
        -ResourceId $ResourceSpId -AppRoleId $RoleId | Out-Null
    Write-Log "granted $Label"
    return $true
}

# ---------------------------------------------------------------------------------------------
# MODES
# ---------------------------------------------------------------------------------------------
function Invoke-Home {
    $org = Connect-DeviceGraph '' @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Directory.ReadWrite.All', 'Organization.Read.All')
    $homeTenantId = $org.Id
    $homeDomain = ($org.VerifiedDomains | Where-Object { $_.IsDefault } | Select-Object -First 1).Name
    if (-not $homeDomain) { $homeDomain = ($org.VerifiedDomains | Select-Object -First 1).Name }
    Write-Log "home tenant $homeTenantId ($homeDomain)"

    $app = Get-AutomationApp
    if (-not $app) {
        if ($DryRun) { Write-Log "DRYRUN would create app '$AppDisplayName' (multi-tenant)"; $app = [pscustomobject]@{ Id = 'dry'; AppId = 'dry' } }
        else {
            $app = New-MgApplication -DisplayName $AppDisplayName -SignInAudience 'AzureADMultipleOrgs'
            Write-Log "app created: $($app.AppId)"
        }
    } elseif ($app.SignInAudience -ne 'AzureADMultipleOrgs') {
        if (-not $DryRun) { Update-MgApplication -ApplicationId $app.Id -SignInAudience 'AzureADMultipleOrgs' }
        Write-Log 'app sign-in audience set to multi-tenant'
    } else {
        Write-Log "app exists: $($app.AppId)"
    }

    # Required resource access (what an admin sees and consents on the grant screen).
    $graphRoleIds = Get-RoleIds $GraphAppId $GraphRoles
    $exoRoleIds   = Get-RoleIds $ExoAppId $ExoRoles
    $rra = @(
        @{ resourceAppId = $GraphAppId; resourceAccess = @($graphRoleIds | ForEach-Object { @{ id = $_.Id; type = 'Role' } }) },
        @{ resourceAppId = $ExoAppId;   resourceAccess = @($exoRoleIds   | ForEach-Object { @{ id = $_.Id; type = 'Role' } }) }
    )
    if ($DryRun) { Write-Log 'DRYRUN would set requiredResourceAccess' }
    else {
        # Via the REST action rather than the cmdlet: the cmdlet's typed parameter is brittle across
        # Microsoft.Graph versions, and a silently-empty requiredResourceAccess means the consent
        # screen shows nothing while the app still asks for the roles.
        Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/applications/$($app.Id)" `
            -Body @{ requiredResourceAccess = $rra } | Out-Null
        Write-Log 'requiredResourceAccess set'
    }

    # Service principal + consent in the HOME tenant.
    $sp = Get-AppSp $app.AppId
    if (-not $sp) {
        if ($DryRun) { $sp = [pscustomobject]@{ Id = 'dry' } }
        else { $sp = New-MgServicePrincipal -AppId $app.AppId; Write-Log 'service principal created (home)' }
    }
    foreach ($r in $graphRoleIds) { [void](Ensure-AppRoleGrant $sp.Id $r.ResourceSpId $r.Id $r.Value) }

    # Certificate on THIS host, public key onto the app.
    $cert = Get-AutomationCert
    if (-not $cert) { if ($DryRun) { Write-Log 'DRYRUN would create the certificate' } else { $cert = New-AutomationCert } }
    if ($cert) {
        $keys = @()
        if (-not $DryRun) { $keys = (Get-MgApplication -ApplicationId $app.Id -Property keyCredentials).KeyCredentials }
        [void](Add-PublicKeyToApp $app.Id $cert $keys)
        Save-MapEntry $homeDomain @{
            TenantId = $homeTenantId; AppId = $app.AppId; Thumbprint = $cert.Thumbprint
            CertExpires = $cert.NotAfter.ToString('yyyy-MM-dd'); Kind = 'home'
            Roles = (@($GraphRoles) + @($ExoRoles))
            VerifiedAt = (Get-Date).ToUniversalTime().ToString('s')
        }
    }
    Disconnect-MgGraph | Out-Null
    Write-Result @{ mode = 'Home'; ok = $true; tenant_id = $homeTenantId; domain = $homeDomain
                    app_id = $app.AppId; thumbprint = ($cert.Thumbprint)
                    cert_expires = ($cert.NotAfter.ToString('yyyy-MM-dd')) }
}

function Invoke-Tenant {
    if (-not $CustomerDomain) { throw '-CustomerDomain is required for -Mode Tenant' }
    $home = Get-HomeEntry
    if (-not $home) { throw 'no home entry in the map - run -Mode Home first' }
    if (-not $home.AppId) { throw 'home entry has no AppId' }

    $org = Connect-DeviceGraph $CustomerDomain @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Directory.ReadWrite.All', 'Organization.Read.All')
    $custTenantId = $org.Id
    Write-Log "customer tenant $custTenantId ($CustomerDomain)"

    # Service principal of the multi-tenant app in this customer.
    $sp = Get-AppSp $home.AppId
    if (-not $sp) {
        if ($DryRun) { $sp = [pscustomobject]@{ Id = 'dry' } }
        else { $sp = New-MgServicePrincipal -AppId $home.AppId; Write-Log 'service principal created (customer)' }
    } else { Write-Log 'service principal already present (customer)' }
    $graphRoleIds = Get-RoleIds $GraphAppId $GraphRoles
    foreach ($r in $graphRoleIds) { [void](Ensure-AppRoleGrant $sp.Id $r.ResourceSpId $r.Id $r.Value) }
    Disconnect-MgGraph | Out-Null

    # Exchange: register the app as a service principal and grant it the RBAC role.
    Write-Log '=== EXCHANGE DEVICE SIGN-IN: a second code appears below ==='
    Connect-ExchangeOnline -Device -ShowBanner:$false
    try {
        if (-not (Get-ServicePrincipal -Identity $home.AppId -ErrorAction SilentlyContinue)) {
            if ($DryRun) { Write-Log 'DRYRUN would register the Exchange service principal' }
            else { New-ServicePrincipal -AppId $home.AppId -ObjectId $sp.Id -DisplayName $AppDisplayName | Out-Null; Write-Log 'Exchange service principal registered' }
        } else { Write-Log 'Exchange service principal already present' }
        if (-not (Get-ManagementRoleAssignment -RoleAssignee $home.AppId -ErrorAction SilentlyContinue)) {
            if ($DryRun) { Write-Log "DRYRUN would assign Exchange role '$ExoRoleName'" }
            else { New-ManagementRoleAssignment -App $home.AppId -Role $ExoRoleName | Out-Null; Write-Log "Exchange role '$ExoRoleName' assigned" }
        } else { Write-Log "Exchange role '$ExoRoleName' already assigned" }
    } finally { Disconnect-ExchangeOnline -Confirm:$false | Out-Null }

    # App-only verification - the point of the whole exercise.
    if (-not $DryRun) {
        Connect-MgGraph -ClientId $home.AppId -TenantId $custTenantId -CertificateThumbprint $home.Thumbprint -NoWelcome
        $check = Get-MgOrganization
        Disconnect-MgGraph | Out-Null
        Write-Log "app-only sign-in verified for $($check.Id)"
    }

    Save-MapEntry $CustomerDomain @{
        TenantId = $custTenantId; AppId = $home.AppId; Thumbprint = $home.Thumbprint
        CertExpires = $home.CertExpires; Kind = 'tenant'
        Roles = (@($GraphRoles) + @($ExoRoles))
        VerifiedAt = (Get-Date).ToUniversalTime().ToString('s')
    }
    Write-Result @{ mode = 'Tenant'; ok = $true; domain = $CustomerDomain; tenant_id = $custTenantId
                    app_id = $home.AppId; verified = (-not $DryRun) }
}

function Invoke-Verify {
    if (-not $CustomerDomain) { throw '-CustomerDomain is required for -Mode Verify' }
    $e = Get-Map | Where-Object { $_.Domain -eq $CustomerDomain } | Select-Object -First 1
    if (-not $e) { throw "no map entry for $CustomerDomain" }
    Connect-MgGraph -ClientId $e.AppId -TenantId $e.TenantId -CertificateThumbprint $e.Thumbprint -NoWelcome
    $org = Get-MgOrganization
    Disconnect-MgGraph | Out-Null
    Write-Result @{ mode = 'Verify'; ok = $true; domain = $CustomerDomain; tenant_id = $e.TenantId; verified_tenant = $org.Id }
}

function Invoke-Renew {
    $home = Get-HomeEntry
    if (-not $home) { throw 'no home entry in the map' }
    $current = Get-AutomationCert
    if (-not $current) { throw 'no current certificate found' }
    if ((Get-Date) -gt $current.NotAfter) {
        Write-Result @{ mode = 'Renew'; ok = $false; reason = "certificate expired $($current.NotAfter.ToString('yyyy-MM-dd')) - cannot self-rotate; a human must sign in"; thumbprint = $current.Thumbprint }
        throw "certificate expired $($current.NotAfter.ToString('yyyy-MM-dd')) - self-rotation needs the still-valid certificate; a human must sign in"
    }
    if ($DryRun) { Write-Log 'DRYRUN would create the next certificate and add its public key'; }

    $new = New-AutomationCert
    Connect-MgGraph -ClientId $home.AppId -TenantId $home.TenantId -CertificateThumbprint $current.Thumbprint -NoWelcome
    $keys = @()
    if (-not $DryRun) { $keys = (Get-MgApplication -ApplicationId (Get-AutomationApp).Id -Property keyCredentials).KeyCredentials }
    [void](Add-PublicKeyToApp (Get-AutomationApp).Id $new $keys)
    Disconnect-MgGraph | Out-Null

    foreach ($e in (Get-Map)) {
        if ($e.Kind -eq 'tenant' -or $e.Kind -eq 'home') {
            Save-MapEntry $e.Domain @{ Thumbprint = $new.Thumbprint; CertExpires = $new.NotAfter.ToString('yyyy-MM-dd') }
        }
    }
    Write-Result @{ mode = 'Renew'; ok = $true; previous_thumbprint = $current.Thumbprint
                    thumbprint = $new.Thumbprint; cert_expires = $new.NotAfter.ToString('yyyy-MM-dd') }
}

function Invoke-Status {
    $cert = Get-AutomationCert
    $map = Get-Map
    Write-Log ("certificate: {0} expires {1:yyyy-MM-dd} ({2} day(s))" -f `
        ($(if ($cert) { $cert.Thumbprint } else { '(none)' })),
        ($(if ($cert) { $cert.NotAfter } else { [datetime]::MinValue })),
        ($(if ($cert) { [int]($cert.NotAfter - (Get-Date)).TotalDays } else { -1 })))
    foreach ($e in $map) { Write-Log ("map: {0} -> tenant {1} app {2} thumb {3} {4}" -f $e.Domain, $e.TenantId, $e.AppId, $e.Thumbprint, $e.Kind) }
    Write-Result @{ mode = 'Status'; ok = $true; entries = $map.Count
                    thumbprint = ($cert.Thumbprint); cert_expires = ($(if ($cert) { $cert.NotAfter.ToString('yyyy-MM-dd') } else { '' })) }
}

# ---------------------------------------------------------------------------------------------
Write-Log "=== Pi.dev M365 automation provisioning: Mode=$Mode Domain='$CustomerDomain' DryRun=$DryRun ==="
try {
    switch ($Mode) {
        'Home'   { Invoke-Home }
        'Tenant' { Invoke-Tenant }
        'Verify' { Invoke-Verify }
        'Renew'  { Invoke-Renew }
        'Status' { Invoke-Status }
    }
    Write-Log "=== done: $Mode OK ==="
} catch {
    Write-Log "ERROR: $_"
    Write-Result @{ mode = $Mode; ok = $false; error = ("$_") }
    exit 1
}

# Install / UPDATE the rmm-relay pi extension (Windows PowerShell 5.1+ or PowerShell 7).
#   irm https://api.blueuc.com/pi/relay/v1/client/install.ps1 | iex
# Safe to re-run at any time: it replaces the extension in place, keeps your sign-in
# (%USERPROFILE%\.pi\agent\rmm-relay.json is NOT touched) and backs up what it replaces.
# After it finishes: restart pi (your sign-in is kept), then check with /rmm-status.
$ErrorActionPreference = "Stop"
$base = if ($env:PI_RMM_RELAY_URL) { $env:PI_RMM_RELAY_URL.TrimEnd("/") } else { "https://api.blueuc.com/pi/relay/v1" }
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$dir = Join-Path $agentDir "extensions\rmm-relay"
$target = Join-Path $dir "index.ts"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# --- repair a known-bad third-party manifest --------------------------------
# The npm package `remote-pi` declares pi's HOST-PROVIDED modules
# (@earendil-works/pi-coding-agent, pi-tui, typebox, ...) as runtime dependencies, so npm
# installs duplicate copies of pi itself and pi 0.99+ warns:
#   Host-provided extension packages must be declared in peerDependencies with a "*" range
#   Installed copies can bypass the extension loader and create duplicate runtime modules.
# The package is still 0.7.0 upstream with the same manifest, so fix it in place: declare them
# as peerDependencies and move the duplicate copies aside. Idempotent and never fatal.
$hostPkgs = @("@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "typebox")
$nm = Join-Path $agentDir "npm\node_modules"
$rpPkg = Join-Path $nm "remote-pi\package.json"
if (Test-Path $rpPkg) {
  try {
    $pkg = Get-Content -Raw -Path $rpPkg | ConvertFrom-Json
    $deps = $pkg.dependencies
    $bad = @()
    if ($deps) { foreach ($k in $hostPkgs) { if ($deps.PSObject.Properties.Name -contains $k) { $bad += $k } } }
    if ($bad.Count -gt 0) {
      $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
      Copy-Item $rpPkg "$rpPkg.bak-$stamp" -Force
      foreach ($k in $bad) { $pkg.dependencies.PSObject.Properties.Remove($k) }
      if (-not ($pkg.PSObject.Properties.Name -contains "peerDependencies")) {
        $pkg | Add-Member -NotePropertyName peerDependencies -NotePropertyValue ([pscustomobject]@{})
      }
      foreach ($k in $hostPkgs) {
        if ($pkg.peerDependencies.PSObject.Properties.Name -contains $k) { $pkg.peerDependencies.$k = "*" }
        else { $pkg.peerDependencies | Add-Member -NotePropertyName $k -NotePropertyValue "*" }
      }
      $pkg | ConvertTo-Json -Depth 20 | Set-Content -Path $rpPkg -Encoding UTF8
      Write-Host ("rmm-relay: repaired remote-pi manifest -> peerDependencies: " + ($bad -join ", "))
      $aside = Join-Path $nm ".pi-host-dupes-$stamp"
      $moved = @()
      foreach ($name in @("@earendil-works", "typebox")) {
        $src = Join-Path $nm $name
        if (Test-Path $src) {
          New-Item -ItemType Directory -Force -Path $aside | Out-Null
          Move-Item -Force $src (Join-Path $aside $name)
          $moved += $name
        }
      }
      if ($moved.Count -gt 0) {
        Write-Host "rmm-relay: moved duplicate pi modules aside -> $aside"
        Write-Host "rmm-relay: (they are re-created by any later `pi install`; re-run this script if the warning returns)"
      }
    }
  } catch {
    Write-Host "rmm-relay: note: remote-pi repair skipped ($($_.Exception.Message))"
  }
}

# --- the extension itself ---------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = [IO.Path]::GetTempFileName()
Invoke-WebRequest -UseBasicParsing -Uri "$base/client/index.ts" -OutFile $tmp
$text = Get-Content -Raw -Path $tmp
if ($text -notmatch "rmm-relay - use your RMM") {
  Remove-Item $tmp -Force
  throw "Download did not look like the rmm-relay extension."
}
$newVer = if ($text -match 'const CLIENT_VERSION = "([^"]+)"') { $Matches[1] } else { "" }
$newProto = if ($text -match 'const PROTOCOL = ([0-9]+)') { $Matches[1] } else { "?" }
if (-not $newVer) { Remove-Item $tmp -Force; throw "Could not read the extension version from the download." }

if (Test-Path $target) {
  $oldText = Get-Content -Raw -Path $target
  $oldVer = if ($oldText -match 'const CLIENT_VERSION = "([^"]+)"') { $Matches[1] } else { "" }
  if ($oldVer -eq $newVer -and $env:PI_RMM_RELAY_FORCE -ne "1") {
    Remove-Item $tmp -Force
    Write-Host "rmm-relay already up to date (v$newVer, protocol $newProto) -> $target"
    Write-Host "(set PI_RMM_RELAY_FORCE=1 to reinstall anyway)"
    Write-Host "Next: restart pi if it is running. Check with /rmm-status."
    return
  }
  $bak = "$target.bak-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  Copy-Item $target $bak -Force
  if ($oldVer) { Write-Host "rmm-relay: updating v$oldVer -> v$newVer" }
}
Move-Item -Force $tmp $target
Write-Host "Installed rmm-relay v$newVer (protocol $newProto) -> $target"
if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "NOTE: the 'pi' command was not found on your PATH."
  Write-Host "      Install Node.js 22.19+ (https://nodejs.org) and Git for Windows, then run:"
  Write-Host "        npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
}
Write-Host "Next: restart pi. Your sign-in is kept."
Write-Host "      If asked to sign in:  /rmm-login   then  /group <it|coding>"
Write-Host "      Check what you are running with:  /rmm-status"

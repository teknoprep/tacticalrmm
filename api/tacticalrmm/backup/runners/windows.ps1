# RMM backup runner - Windows (PowerShell 5.1+, runs as SYSTEM). Dispatched by the RMM backup
# module; edit it in the source tree (backup/runners/windows.ps1), not in the Script Manager.
#
# Input (env, set by the dispatcher): RMM_BACKUP_API, RMM_BACKUP_TOKEN (one run, expires).
# Paths, destination and the repository password are fetched with that token, so nothing secret
# is in the script body, its arguments, or the TRMM audit log.
# Destinations: S3 (native), SMB / FTP / SFTP (through rclone, no drive mapping), local path.
# NFS is Linux-only. Open files are read from a VSS shadow copy (restic --use-fs-snapshot).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Api = $env:RMM_BACKUP_API
$Token = $env:RMM_BACKUP_TOKEN
if (-not $Api -or -not $Token) { Write-Output 'RMM_BACKUP_API / RMM_BACKUP_TOKEN not set'; exit 2 }

$Base = Join-Path $env:ProgramData 'RMMBackup'
$Bin = Join-Path $Base 'bin'
$Work = Join-Path $Base 'work'
foreach ($d in @($Base, $Bin, $Work, (Join-Path $Base 'cache'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
# SYSTEM and Administrators only: the cache and work files describe the backup
& icacls $Base /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 2>&1 | Out-Null

# one log per runner process: a job queued behind the host mutex must not write into the log of
# the run that holds it (old logs of killed runners are swept)
Get-ChildItem $Work -Filter 'run-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue
$LogFile = Join-Path $Work "run-$PID.log"
Set-Content -Path $LogFile -Value '' -Encoding UTF8
$T0 = Get-Date
$Headers = @{ 'X-Backup-Token' = $Token }
$script:Reported = $false
$script:Stats = @{ bytes_added = 0; total_bytes = 0; files_new = 0; snapshots = 0; snapshot_id = '' }

function Log([string]$msg) {
    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $msg
    Write-Output $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Report-Done([string]$status, [string]$message) {
    Log "result: $status - $message"
    $tail = (Get-Content -Path $LogFile -Tail 300 -ErrorAction SilentlyContinue) -join "`n"
    $body = @{
        phase            = 'done'
        status           = $status
        message          = $message
        bytes_added      = [int64]$script:Stats.bytes_added
        total_bytes      = [int64]$script:Stats.total_bytes
        files_new        = [int64]$script:Stats.files_new
        snapshots        = [int64]$script:Stats.snapshots
        snapshot_id      = $script:Stats.snapshot_id
        duration_seconds = [int]((Get-Date) - $T0).TotalSeconds
        log              = $tail
    } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$Api/backup/agent/report/" -Headers $Headers `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
    } catch { Write-Output "could not post the result to ${Api}: $($_.Exception.Message)" }
    $script:Reported = $true
}

function Fail([string]$message) { Report-Done 'error' $message; throw 'RMMBACKUP-FAIL' }

function Get-Verified([string]$url, [string]$file, [string]$sha) {
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
    $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
    if ($got -ne $sha.ToLower()) { Remove-Item $file -Force; Fail "checksum mismatch for $url ($got)" }
}

function Expand-One([string]$zip, [string]$member, [string]$dest) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $e = $z.Entries | Where-Object { $_.FullName -eq $member } | Select-Object -First 1
        if (-not $e) { Fail "$member not found in $zip" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
    } finally { $z.Dispose() }
}

function Join-RepoPath([string[]]$parts) {
    ($parts | ForEach-Object { if ($_) { $_.Trim('/', '\') } } | Where-Object { $_ }) -join '/'
}

# Run an executable, append its stderr to the log, return stdout lines. Sets $script:LastExit.
function Invoke-Tool([string]$exe, [string[]]$arguments) {
    # PS 5.1 turns redirected native stderr into errors; under 'Stop' that would abort the run
    $ErrorActionPreference = 'Continue'
    $errFile = Join-Path $Work 'stderr.txt'
    $out = & $exe @arguments 2> $errFile
    $script:LastExit = $LASTEXITCODE
    if (Test-Path $errFile) {
        Get-Content $errFile | Select-Object -Last 200 | ForEach-Object { Add-Content -Path $LogFile -Value $_ -Encoding UTF8 }
        Remove-Item $errFile -Force
    }
    return $out
}

$mutex = New-Object Threading.Mutex($false, 'Global\RMMBackupRunner')
try {
    # one runner at a time per host: a second job waits (up to 2h) instead of failing.
    # An abandoned mutex (previous runner killed) is ours: WaitOne throws but we hold it.
    $got = $false
    try { $got = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $got = $true }
    if (-not $got) {
        Invoke-RestMethod -Method Post -Uri "$Api/backup/agent/report/" -Headers $Headers -ContentType 'application/json' `
            -Body '{"phase":"start","message":"waiting for another backup run on this host"}' | Out-Null
        try { $got = $mutex.WaitOne(7200000) } catch [Threading.AbandonedMutexException] { $got = $true }
    }
    if (-not $got) {
        $script:Reported = $true
        $b = '{"phase":"done","status":"error","message":"another backup run held the host lock for over 2h"}'
        Invoke-RestMethod -Method Post -Uri "$Api/backup/agent/report/" -Headers $Headers -ContentType 'application/json' -Body $b | Out-Null
        exit 1
    }

    try { $J = Invoke-RestMethod -Uri "$Api/backup/agent/job/" -Headers $Headers -UseBasicParsing }
    catch { Fail "could not fetch the job from $Api (expired token or API error): $($_.Exception.Message)" }
    Invoke-RestMethod -Method Post -Uri "$Api/backup/agent/report/" -Headers $Headers -ContentType 'application/json' `
        -Body '{"phase":"start","message":"running"}' | Out-Null
    $D = $J.dest
    Log "job '$($J.job)' run $($J.run_id) on $($J.host) -> $($D.provider)"

    if (-not [Environment]::Is64BitOperatingSystem) { Fail '32-bit Windows is not supported' }
    $Tools = $J.tools

    # ------------------------------------------------------------ engines (pinned + verified)
    $Restic = Join-Path $Bin "restic-$($Tools.restic_version).exe"
    if (-not (Test-Path $Restic)) {
        Log "installing restic $($Tools.restic_version)"
        $v = $Tools.restic_version
        $zip = Join-Path $Work 'restic.zip'
        Get-Verified "https://github.com/restic/restic/releases/download/v$v/restic_${v}_windows_amd64.zip" $zip $Tools.restic.'windows-amd64'
        Expand-One $zip "restic_${v}_windows_amd64.exe" "$Restic.new"
        Move-Item "$Restic.new" $Restic -Force
        Remove-Item $zip -Force
    }
    $Rclone = Join-Path $Bin "rclone-$($Tools.rclone_version).exe"
    function Need-Rclone {
        if (Test-Path $Rclone) { return }
        Log "installing rclone $($Tools.rclone_version)"
        $v = $Tools.rclone_version
        $zip = Join-Path $Work 'rclone.zip'
        Get-Verified "https://downloads.rclone.org/v$v/rclone-v$v-windows-amd64.zip" $zip $Tools.rclone.'windows-amd64'
        Expand-One $zip "rclone-v$v-windows-amd64/rclone.exe" "$Rclone.new"
        Move-Item "$Rclone.new" $Rclone -Force
        Remove-Item $zip -Force
    }

    # ------------------------------------------------------------ repository
    $env:RESTIC_PASSWORD = $J.repo_password
    $env:RESTIC_CACHE_DIR = Join-Path $Base 'cache'
    $ResticOpts = @()

    function Use-Rclone([string]$type) {
        Need-Rclone
        # empty config: everything comes from RCLONE_CONFIG_RMMB_* (silences "config not found")
        $env:RCLONE_CONFIG = Join-Path $Work 'rclone.conf'
        Set-Content -Path $env:RCLONE_CONFIG -Value '' -Encoding ASCII
        $env:RCLONE_CONFIG_RMMB_TYPE = $type
        $env:RCLONE_CONFIG_RMMB_HOST = $D.host
        if ([int]$D.port -gt 0) { $env:RCLONE_CONFIG_RMMB_PORT = [string]$D.port }
        $user = [string]$D.username
        if ($type -eq 'smb' -and $user.Contains('\')) {
            $env:RCLONE_CONFIG_RMMB_DOMAIN = $user.Split('\')[0]; $user = $user.Split('\', 2)[1]
        }
        if ($user) { $env:RCLONE_CONFIG_RMMB_USER = $user }
        if ($D.secret) {
            $env:RCLONE_CONFIG_RMMB_PASS = ($D.secret | & $Rclone obscure -)
            if ($LASTEXITCODE -ne 0) { Fail 'rclone obscure failed' }
        }
        if ($type -eq 'ftp' -and $D.tls) { $env:RCLONE_CONFIG_RMMB_EXPLICIT_TLS = 'true' }
        $script:ResticOpts += @('-o', "rclone.program=$Rclone")
    }

    switch ($D.provider) {
        's3' {
            $ep = if ($D.endpoint) { $D.endpoint.TrimEnd('/') } else { "https://s3.$(if ($D.region) { $D.region } else { 'us-east-1' }).amazonaws.com" }
            $env:AWS_ACCESS_KEY_ID = $D.username
            $env:AWS_SECRET_ACCESS_KEY = $D.secret
            $env:AWS_DEFAULT_REGION = if ($D.region) { $D.region } else { 'us-east-1' }
            $env:RESTIC_REPOSITORY = "s3:$ep/" + (Join-RepoPath @($D.share, $D.path, $J.repo_path))
        }
        { $_ -in @('smb', 'ftp', 'sftp') } {
            Use-Rclone $D.provider
            $env:RESTIC_REPOSITORY = 'rclone:rmmb:' + (Join-RepoPath @($D.share, $D.path, $J.repo_path))
        }
        'local' {
            $env:RESTIC_REPOSITORY = (Join-Path $D.path ($J.repo_path -replace '/', '\'))
            New-Item -ItemType Directory -Path $env:RESTIC_REPOSITORY -Force | Out-Null
        }
        'nfs' { Fail 'NFS locations are Linux-only; use an SMB location for Windows hosts' }
        default { Fail "unknown destination type '$($D.provider)'" }
    }
    $J.repo_password = $null; $D.secret = $null
    Log ('repository: ' + ($env:RESTIC_REPOSITORY -replace '@.*', ''))

    function R([string[]]$a) { return Invoke-Tool $Restic ($ResticOpts + $a) }

    R @('cat', 'config') | Out-Null
    if ($script:LastExit -ne 0) {
        Log 'no repository yet - initialising'
        R @('init') | Out-Null
        if ($script:LastExit -ne 0) {
            # behind restic, rclone only says "exit status 1"; ask rclone directly for the real cause
            # (e.g. 'failed to make FTP connection ... 530'). Lines naming pass/obscure never leave the host.
            $why = $null
            if ($env:RCLONE_CONFIG_RMMB_TYPE) {
                # stderr to a file, 'Continue': PS 5.1 would throw on native stderr under 'Stop'
                $probeFile = Join-Path $Work 'probe.txt'
                & {
                    $ErrorActionPreference = 'Continue'
                    & $Rclone lsd 'rmmb:' --retries 1 --low-level-retries 1 --contimeout 20s --timeout 30s 2> $probeFile | Out-Null
                }
                $why = Get-Content $probeFile -ErrorAction SilentlyContinue |
                    Where-Object { $_ -cmatch 'ERROR|CRITICAL|Failed|failed' -and $_ -notmatch 'pass(word)? *[=:]|obscure' } |
                    Select-Object -Last 1
                Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
                if ($why) { Log "rclone probe: $why" }
            }
            if (-not $why) {
                $why = Get-Content $LogFile -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Fatal|error' } | Select-Object -Last 1
            }
            if ($why) { $why = ($why -creplace '^.*(CRITICAL|ERROR) *: *', '') -replace '(Fatal: )+', 'Fatal: ' }
            if ($why -and $why.Length -gt 300) { $why = $why.Substring(0, 300) }
            $hint = ''
            if ($D.provider -eq 'ftp' -and $D.tls -and "$why" -match '530') { $hint = ' (FTPS is on: the server may not support explicit TLS)' }
            if (-not $why) { $why = 'see log' }
            Fail "could not open or create the repository$($hint): $why"
        }
    }
    R @('unlock') | Out-Null

    # ------------------------------------------------------------ backup
    $paths = @(); $missing = @()
    foreach ($p in @($J.paths)) {
        if (-not $p) { continue }
        if (Test-Path -LiteralPath $p) { $paths += $p } else { $missing += $p }
    }
    if ($paths.Count -eq 0) { Fail ("none of the job's paths exist on this host: " + (@($J.paths) -join ', ')) }
    if ($missing.Count -gt 0) { Log ('skipping paths that do not exist: ' + ($missing -join ', ')) }
    $pathsFile = Join-Path $Work 'paths.txt'; $exclFile = Join-Path $Work 'excludes.txt'
    [IO.File]::WriteAllLines($pathsFile, [string[]]$paths)
    [IO.File]::WriteAllLines($exclFile, [string[]]@($J.excludes | Where-Object { $_ }))

    $bargs = @('backup', '--json', '--use-fs-snapshot', '--host', $J.host, '--tag', 'rmm-backup', '--tag', "run-$($J.run_id)",
        '--files-from', $pathsFile, '--exclude-file', $exclFile)
    if ([int]$J.limit_upload_kib -gt 0) { $bargs += @('--limit-upload', [string]$J.limit_upload_kib) }
    Log 'backup starting (VSS)'
    $out = R $bargs
    $rc = $script:LastExit
    $summary = $out | Where-Object { $_ -match '"message_type":"summary"' } | Select-Object -Last 1
    $out | Where-Object { $_ -match '"message_type":"error"' } | Select-Object -First 20 | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    if ($summary) {
        $s = $summary | ConvertFrom-Json
        # data_added_packed = actual repository growth (after compression)
        $script:Stats.bytes_added = if ($null -ne $s.data_added_packed) { $s.data_added_packed } else { $s.data_added }
        $script:Stats.total_bytes = $s.total_bytes_processed
        $script:Stats.files_new = $s.files_new
        if ($s.snapshot_id) { $script:Stats.snapshot_id = $s.snapshot_id.Substring(0, 8) }
    }
    $status = 'ok'; $msg = "snapshot $($script:Stats.snapshot_id)"
    if ($rc -eq 3) { $status = 'warn'; $msg += ', but some files could not be read (see log)' }
    elseif ($rc -ne 0) { Fail "restic backup failed (exit $rc) - see log" }
    if ($missing.Count -gt 0) { $status = 'warn'; $msg += '; missing paths: ' + ($missing -join ', ') }

    # ------------------------------------------------------------ retention + validation
    $forget = @('forget', '--host', $J.host, '--keep-daily', [string]$J.keep_daily, '--keep-weekly', [string]$J.keep_weekly,
        '--keep-monthly', [string]$J.keep_monthly)
    if ($J.prune) { $forget += '--prune' }
    Log ('retention: ' + ($forget -join ' '))
    R $forget | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    if ($script:LastExit -ne 0) { $status = 'warn'; $msg += '; retention failed' }

    $check = @('check')
    if ($J.check_subset) { $check += "--read-data-subset=$($J.check_subset)" }
    Log ('validation: ' + ($check -join ' '))
    R $check | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    if ($script:LastExit -ne 0) {
        $status = 'error'; $msg += '; REPOSITORY CHECK FAILED - do not trust this repo until investigated'
    } else {
        $msg += '; check ok'
        if ($J.check_subset) { $msg += " (read $($J.check_subset) of data)" }
    }

    $snaps = R @('snapshots', '--host', $J.host, '--json')
    try { $script:Stats.snapshots = @(($snaps -join '') | ConvertFrom-Json).Count } catch { }

    Report-Done $status $msg
    if ($status -eq 'error') { exit 1 }
    exit 0
}
catch {
    if (-not $script:Reported) { Report-Done 'error' ("runner error: " + $_.Exception.Message) }
    exit 1
}
finally {
    foreach ($v in @('RESTIC_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'RCLONE_CONFIG_RMMB_PASS')) {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
    try { $mutex.ReleaseMutex() } catch { }
    Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
}

#Requires -Version 5.1
<#
M0 helper for Windows 10/11, Windows PowerShell 5.1 or PowerShell 7.
Collect: read-only environment and candidate binary hashes.
Observe: read-only input desktop / cursor state; no input events or content.
Uac: explicitly request elevation of a disposable PowerShell window.
No software installation, firewall/UAC policy changes, or execution-policy changes.
#>
[CmdletBinding()]
param(
    [ValidateSet('Collect', 'Observe', 'Uac')]
    [string]$Mode = 'Collect',
    [ValidateRange(10, 3600)]
    [int]$Seconds = 180,
    [string]$OutputDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Resolve script-relative paths in the script body, after parameter binding.
# Windows PowerShell may expose an empty PSScriptRoot during default binding.
$scriptDirectory = [System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    throw 'Cannot resolve the helper directory. Run this script with powershell.exe -File.'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path -Path $scriptDirectory -ChildPath 'results'
}
if ($env:OS -ne 'Windows_NT') { throw 'This helper requires a real Windows desktop.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).ProviderPath
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID

if ($Mode -eq 'Collect') {
    $errors = New-Object 'System.Collections.Generic.List[string]'
    function Read-Optional([scriptblock]$Action) {
        try { & $Action } catch { $errors.Add($_.Exception.Message); return $null }
    }
    $os = Read-Optional { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $policyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $policies = [ordered]@{}
    foreach ($name in @('EnableLUA', 'PromptOnSecureDesktop', 'ConsentPromptBehaviorAdmin',
        'ConsentPromptBehaviorUser', 'EnableUIADesktopToggle', 'EnableSecureUIAPaths')) {
        $value = Read-Optional { Get-ItemPropertyValue -Path $policyPath -Name $name }
        # Missing registry values are unknown, never interpreted as a disabled policy.
        $policies[$name] = $value
    }
    $services = @(Read-Optional {
        Get-CimInstance Win32_Service | Where-Object {
            $_.Name -match 'deskflow|lan.?mouse' -or $_.DisplayName -match 'deskflow|lan.?mouse'
        } | Select-Object Name, State, StartMode, StartName
    })
    $processes = @(Read-Optional {
        Get-Process | Where-Object { $_.ProcessName -match '^(deskflow.*|lan-mouse)$' } |
            Select-Object ProcessName, Id, SessionId
    })
    $mice = @(Read-Optional {
        Get-CimInstance Win32_PointingDevice | Select-Object Name, Status, HardwareType
    })
    $binaries = @()
    $candidatePaths = @()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($root) {
            $folder = Join-Path $root 'Deskflow'
            if (Test-Path -LiteralPath $folder) {
                $candidatePaths += @(Get-ChildItem -LiteralPath $folder -Filter '*.exe' -File)
            }
        }
    }
    foreach ($file in $candidatePaths) {
        $signature = Read-Optional { Get-AuthenticodeSignature -LiteralPath $file.FullName }
        $signatureStatus = 'unknown'
        if ($null -ne $signature) { $signatureStatus = [string]$signature.Status }
        $binaries += [ordered]@{
            name = $file.Name
            version = $file.VersionInfo.FileVersion
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            signatureStatus = $signatureStatus
        }
    }
    $report = [ordered]@{
        schema = 1; recordedUtc = [DateTime]::UtcNow.ToString('o')
        os = $os; powershellVersion = $PSVersionTable.PSVersion.ToString()
        observerElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        observerSessionId = (Get-Process -Id $PID).SessionId
        uacPolicy = $policies; candidateServices = $services; candidateProcesses = $processes
        pointingDevices = $mice; binaries = $binaries; collectionErrors = @($errors.ToArray())
        verdict = 'NOT_TESTED'
    }
    $path = Join-Path $OutputDirectory ('environment-' + $runId + '.json')
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
    Write-Host ('Saved: ' + $path)
    Write-Host 'Environment collection does not prove UAC control. Do not include credentials in test notes.'
    return
}

if ($Mode -eq 'Observe') {
    if (-not ('WenBox.M0.DesktopProbe' -as [type])) {
        Add-Type -Path (Join-Path $scriptDirectory 'DesktopProbe.cs')
    }
    $path = Join-Path $OutputDirectory ('desktop-' + $runId + '.jsonl')
    $writer = New-Object System.IO.StreamWriter($path, $false, (New-Object System.Text.UTF8Encoding($false)))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        Write-Host ('Observing for ' + $Seconds + ' seconds. Ctrl+C stops. Output: ' + $path)
        while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
            $sample = [WenBox.M0.DesktopProbe]::Read()
            $writer.WriteLine(($sample | ConvertTo-Json -Compress))
            $writer.Flush()
            Start-Sleep -Milliseconds 250
        }
    } finally { $writer.Dispose() }
    Write-Host 'Desktop access denied during UAC is expected for a normal observer; it is not a backend failure verdict.'
    return
}

# A disposable elevated shell with only a fixed, read-only smoke test prompt.
# Declining UAC starts no process. A local recovery keyboard must remain available.
$payload = @'
$Host.UI.RawUI.WindowTitle = 'WenBox M0 - elevated input test'
Write-Host 'Type exactly: WENBOX-M0-ADMIN-123 (test marker, no password)'
$marker = Read-Host 'Marker'
if ($marker -ceq 'WENBOX-M0-ADMIN-123') { Write-Host 'Marker matched. Record the manual test result.' }
else { Write-Host 'Marker did not match. Record FAIL and the observed behavior.' }
Read-Host 'Press Enter to close'
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
$windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    Start-Process -FilePath $windowsPowerShell -Verb RunAs -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) | Out-Null
    Write-Host 'Complete or reject the UAC prompt from the Mac. No test verdict is inferred automatically.'
} catch {
    Write-Host ('UAC was declined or the process could not start: ' + $_.Exception.Message)
}

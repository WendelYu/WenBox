param([string]$OutputDirectory = 'release-win')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $target = Join-Path $root 'src-tauri/target'
    $exe = "WenBox-Windows-v${version}-Portable-x64.exe"
    $previousConfig = $env:TAURI_CONFIG
    try {
        $env:TAURI_CONFIG = Get-Content src-tauri/tauri.portable.conf.json -Raw
        cargo build --locked --release --manifest-path src-tauri/Cargo.toml --target-dir $target --bin wenbox --features portable
        if ($LASTEXITCODE -ne 0) { throw 'Windows portable build failed' }
    } finally {
        $env:TAURI_CONFIG = $previousConfig
    }

    # Launch a lone EXE from an empty directory to prove it needs no input resources.
    $smoke = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $smoke | Out-Null
    $process = $null
    try {
        $existing = Get-NetTCPConnection -LocalPort 9527 -State Listen -ErrorAction SilentlyContinue
        if ($existing) { throw 'Close the running WenBox before packaging the portable build (port 9527 is in use)' }
        $file = Join-Path $smoke $exe
        Copy-Item (Join-Path $target 'release/wenbox.exe') $file
        $bytes = [IO.File]::ReadAllBytes($file)
        $pe = [BitConverter]::ToInt32($bytes, 60)
        if ([BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) {
            throw 'Portable executable is not an x64 Windows PE'
        }
        $process = Start-Process -FilePath $file -WorkingDirectory $smoke -PassThru
        $status = $null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($process.HasExited) { throw "Portable WenBox exited with code $($process.ExitCode)" }
            try {
                $status = Invoke-RestMethod -Uri 'http://127.0.0.1:9527/api/status' -TimeoutSec 2
                $process.Refresh()
                if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
                Start-Sleep -Milliseconds 500
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Portable WebView window did not open' }
        if ($status.running -ne $true -or $status.version -ne $version) { throw 'Portable HTTP service or version check failed' }
        try {
            Invoke-WebRequest -Uri 'http://127.0.0.1:9527/api/kvm/info' -UseBasicParsing -TimeoutSec 2 | Out-Null
            throw 'Portable build exposes the input service API'
        } catch {
            if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw }
        }
        if (-not (Get-NetTCPConnection -LocalPort 9527 -State Listen -OwningProcess $process.Id -ErrorAction SilentlyContinue)) {
            throw 'Portable EXE did not start its own HTTP service'
        }
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
        Copy-Item $file (Join-Path $OutputDirectory $exe) -Force
        Write-Host "Verified portable Windows EXE: $exe"
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit(5000) | Out-Null
        }
        Remove-Item $smoke -Recurse -Force
    }
} finally {
    Pop-Location
}

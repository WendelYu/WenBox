#Requires -Version 5.1
# Only disposable GitHub Windows runners: installs/upgrades/uninstalls each path.
param([Parameter(Mandatory=$true)][string]$Installer)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run this destructive installation matrix only on a disposable GitHub Actions runner.' }
& (Join-Path $PSScriptRoot 'check-kvm-installation.ps1') -Installer $Installer
& (Join-Path $PSScriptRoot 'check-kvm-installation.ps1') -Installer $Installer -InstallDirectory (Join-Path $env:ProgramFiles 'WenBox Custom Path')
$parent='D:\App'
if (Test-Path -LiteralPath $parent) { throw 'Disposable D:\App already exists' }
New-Item -ItemType Directory -Path $parent | Out-Null
try {
    & icacls.exe $parent /setowner ('*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot set ordinary app parent owner' }
    & icacls.exe $parent /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot set ordinary app parent ACL' }
    $before=(Get-Acl -LiteralPath $parent).Sddl
    & (Join-Path $PSScriptRoot 'check-kvm-installation.ps1') -Installer $Installer -InstallDirectory 'D:\App\WenBox'
    if ((Get-Acl -LiteralPath $parent).Sddl -ne $before) { throw 'Installer changed the shared app parent ACL' }
    Write-Output 'PASS: D:\App\WenBox installed/upgraded/uninstalled without altering D:\App permissions'
} finally { Remove-Item -LiteralPath $parent -Force -Recurse }

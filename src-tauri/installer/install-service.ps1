#Requires -Version 5.1
# Runs only from the elevated unified installer. No network or arbitrary service commands.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Install','Uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell for service installation.' }
$expected = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WenBox'
if ([IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') -ine $expected.TrimEnd('\')) { throw 'The privileged input component requires the standard Program Files\WenBox installation directory.' }
$serviceName = 'WenBoxKvm'
$stateRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'WenBoxKvm'
$binary = Join-Path $InstallRoot 'resources\kvm\wenbox-kvm-service.exe'
function Reject-Reparse([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Refusing reparse point: ' + $Path) }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $Path -Force -Recurse) {
                if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Refusing nested reparse point: ' + $child.FullName) }
            }
        }
    }
}
Reject-Reparse $InstallRoot
Reject-Reparse $stateRoot
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $svc -and $svc.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
}
if ($Action -eq 'Prepare') { exit 0 }
$sc = Join-Path $env:WINDIR 'System32\sc.exe'
function Native([string]$Exe,[string[]]$Arguments) { & $Exe @Arguments | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('Native installation action failed: ' + $Exe + ' exit ' + $LASTEXITCODE) } }
if ($Action -eq 'Uninstall') {
    if ($null -ne $svc) { Native $sc @('delete',$serviceName) }
    & (Join-Path $env:WINDIR 'System32\netsh.exe') advfirewall firewall delete rule name='WenBox KVM Control' | Out-Null
    & (Join-Path $env:WINDIR 'System32\netsh.exe') advfirewall firewall delete rule name='WenBox KVM Input' | Out-Null
    if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
    exit 0
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Input service executable is missing.' }
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$icacls = Join-Path $env:WINDIR 'System32\icacls.exe'
# Replace the root DACL exactly; /grant alone would leave an attacker's explicit ACEs.
foreach ($folder in @($InstallRoot,$stateRoot)) {
    Native $icacls @($folder,'/setowner','*S-1-5-18','/T','/C')
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($folder -eq $InstallRoot) {
        $read = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($read)
    }
    Set-Acl -LiteralPath $folder -AclObject $acl
    if (@(Get-ChildItem -LiteralPath $folder -Force).Count -gt 0) { Native $icacls @((Join-Path $folder '*'),'/reset','/T','/C') }
}
$quotedBinary = '"' + $binary + '"'
if ($null -eq $svc) { Native $sc @('create',$serviceName,'binPath=',$quotedBinary,'start=','auto','obj=','LocalSystem','DisplayName=','WenBox Input Service') }
else { Native $sc @('config',$serviceName,'binPath=',$quotedBinary,'start=','auto','obj=','LocalSystem') }
Native $sc @('description',$serviceName,'WenBox keyboard and mouse input for paired devices. No network listener in this service.')
Native $sc @('failure',$serviceName,'reset=','86400','actions=','restart/3000/restart/10000/restart/30000')
$netsh = Join-Path $env:WINDIR 'System32\netsh.exe'
& $netsh advfirewall firewall delete rule name='WenBox KVM Control' | Out-Null
& $netsh advfirewall firewall delete rule name='WenBox KVM Input' | Out-Null
Native $netsh @('advfirewall','firewall','add','rule','name=WenBox KVM Control','dir=in','action=allow','protocol=TCP','localport=9530','remoteip=LocalSubnet','profile=any',('program=' + (Join-Path $InstallRoot 'wenbox.exe')))
Native $netsh @('advfirewall','firewall','add','rule','name=WenBox KVM Input','dir=in','action=allow','protocol=TCP','localport=9531','remoteip=LocalSubnet','profile=any',('program=' + (Join-Path $InstallRoot 'resources\kvm\input\deskflow-core.exe')))
Native $sc @('start',$serviceName,'resume-user-app')
(Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))

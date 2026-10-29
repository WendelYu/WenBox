#Requires -Version 5.1
# Runs only from the elevated unified installer. No network or arbitrary service commands.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Install','Uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [switch]$SkipLaunch
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
trap {
    $failure = $_.ToString() + "`r`n" + $_.ScriptStackTrace
    try {
        $log = Join-Path ([IO.Path]::GetTempPath()) 'WenBox-Kvm-Install.log'
        [IO.File]::AppendAllText($log, ((Get-Date -Format o) + ' Action=' + $Action + "`r`n" + $failure + "`r`n"))
    } catch { }
    [Console]::Error.WriteLine($failure)
    exit 1
}
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell for service installation.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -notmatch '^[A-Za-z]:\\[^\\]') { throw '请选择本地磁盘上的专用安装文件夹。' }
$drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($InstallRoot))
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS','ReFS')) { throw '输入服务需要支持 Windows 权限的本地固定磁盘（NTFS / ReFS）。' }
$trustedOwners = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$weakGroups = @('S-1-1-0','S-1-5-11','S-1-5-32-545')
$dangerous = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete
function New-ProtectedInstallAcl {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    return $acl
}
$missingParents = New-Object 'Collections.Generic.List[string]'
$parent = [IO.Directory]::GetParent($InstallRoot)
while ($null -ne $parent) {
    if (Test-Path -LiteralPath $parent.FullName) {
        $item = Get-Item -LiteralPath $parent.FullName -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装目录不能经过符号链接或目录联接。' }
        $acl = Get-Acl -LiteralPath $parent.FullName
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin $trustedOwners) { throw '安装目录的父目录由普通用户管理。请选择 Program Files 内的文件夹，或磁盘根目录下新建的专用文件夹（例如 D:\WenBox）。' }
        foreach ($rule in $acl.Access) {
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($rule.AccessControlType -eq 'Allow' -and $sid -in $weakGroups -and ($rule.FileSystemRights -band $dangerous)) { throw '父目录允许普通用户替换安装文件夹，请选择受保护的安装位置。' }
        }
    } else { $missingParents.Add($parent.FullName) }
    $parent = $parent.Parent
}
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
if ($Action -eq 'Prepare') {
    if (Test-Path -LiteralPath $InstallRoot) {
        $owner = (Get-Acl -LiteralPath $InstallRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin $trustedOwners) { throw '请选择一个新的专用安装目录；现有目录由普通用户管理。' }
        if (@(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'uninstall.exe'))) { throw '安装目录已有其他文件，请选择空文件夹。' }
    }
    function Assert-ProtectedFolder([string]$Path) {
        $acl = Get-Acl -LiteralPath $Path
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedOwners) { throw '安装目录被其他用户占用，请选择新的文件夹。' }
        $writeBits = [Security.AccessControl.FileSystemRights]::Write -bor $dangerous
        foreach ($rule in $acl.Access) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $trustedOwners -and ($rule.FileSystemRights -band $writeBits)) { throw '安装目录允许普通用户修改，请选择受保护的专用文件夹。' }
        }
    }
    $initialAcl = New-ProtectedInstallAcl
    for ($i = $missingParents.Count - 1; $i -ge 0; $i--) {
        [void][IO.Directory]::CreateDirectory($missingParents[$i], $initialAcl)
        Assert-ProtectedFolder $missingParents[$i]
    }
    if (-not (Test-Path -LiteralPath $InstallRoot)) {
        [void][IO.Directory]::CreateDirectory($InstallRoot, $initialAcl)
    }
    Assert-ProtectedFolder $InstallRoot
    exit 0
}
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
# Use structured service APIs so Windows PowerShell 5.1 native argument quoting
# cannot strip the required quotes around a Program Files executable path.
if ($null -eq $svc) {
    New-Service -Name $serviceName -BinaryPathName $quotedBinary -StartupType Automatic -DisplayName 'WenBox Input Service' | Out-Null
} else {
    $existing = Get-CimInstance Win32_Service -Filter "Name='WenBoxKvm'"
    $changed = Invoke-CimMethod -InputObject $existing -MethodName Change -Arguments @{PathName=$quotedBinary; StartMode='Automatic'; StartName='LocalSystem'}
    if ($changed.ReturnValue -ne 0) { throw ('Service configuration failed: ' + $changed.ReturnValue) }
}
Native $sc @('description',$serviceName,'WenBox keyboard and mouse input for paired devices. No network listener in this service.')
Native $sc @('failure',$serviceName,'reset=','86400','actions=','restart/3000/restart/10000/restart/30000')
$netsh = Join-Path $env:WINDIR 'System32\netsh.exe'
& $netsh advfirewall firewall delete rule name='WenBox KVM Control' | Out-Null
& $netsh advfirewall firewall delete rule name='WenBox KVM Input' | Out-Null
Native $netsh @('advfirewall','firewall','add','rule','name=WenBox KVM Control','dir=in','action=allow','protocol=TCP','localport=9530','remoteip=LocalSubnet','profile=any',('program=' + (Join-Path $InstallRoot 'wenbox.exe')))
Native $netsh @('advfirewall','firewall','add','rule','name=WenBox KVM Input','dir=in','action=allow','protocol=TCP','localport=9531','remoteip=LocalSubnet','profile=any',('program=' + (Join-Path $InstallRoot 'resources\kvm\input\deskflow-core.exe')))
if ($SkipLaunch) { Native $sc @('start',$serviceName) } else { Native $sc @('start',$serviceName,'resume-user-app') }
(Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))

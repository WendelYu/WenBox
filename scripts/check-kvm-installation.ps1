#Requires -Version 5.1
# Run only on a disposable Windows build/test machine: installs, upgrades, then uninstalls WenBox.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Installer)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WenBox'
$state=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'WenBoxKvm'
if (Get-Service -Name WenBoxKvm -ErrorAction SilentlyContinue) { throw 'This smoke test requires a clean disposable machine, not an existing WenBox installation.' }
function Stop-TestApp { Get-Process -Name 'wenbox' -ErrorAction SilentlyContinue | Stop-Process -Force }
function Run-Installer([string]$Path) { $p=Start-Process -FilePath $Path -ArgumentList '/S' -PassThru -Wait; if($p.ExitCode -ne 0){throw ('Installer exit '+$p.ExitCode)} }
try {
 Run-Installer $Installer
 $service=Get-Service -Name WenBoxKvm
 if($service.Status -ne 'Running'){throw 'Input service did not start'}
 $service.Dispose()
 foreach($file in @('wenbox.exe','resources\kvm\wenbox-kvm-service.exe','resources\kvm\input\deskflow-core.exe','resources\kvm\input\settings\Deskflow.conf')) { if(-not(Test-Path -LiteralPath (Join-Path $root $file))){throw ('Missing '+$file)} }
 $acl=Get-Acl -LiteralPath $state
 if(-not $acl.AreAccessRulesProtected){throw 'Input state directory must have a protected DACL'}
 foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin @('S-1-5-18','S-1-5-32-544')){throw ('Unexpected input-state ACL principal '+$sid)}}
 $registered=Get-CimInstance Win32_Service -Filter "Name='WenBoxKvm'"
 if($registered.StartName -ne 'LocalSystem'){throw 'Service must use the system account'}
 # Even administrators using another executable must not receive an accepted service reply.
 $pipe=New-Object IO.Pipes.NamedPipeClientStream('.', 'WenBox.Kvm.v1', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
 $connected=$false
 $rejected=$false
 try {
  $pipe.Connect(3000)
  $connected=$true
  $bytes=[Text.Encoding]::UTF8.GetBytes('{"action":"status"}'+"`n")
  $pipe.Write($bytes,0,$bytes.Length)
  $buffer=New-Object byte[] 1
  $read=$pipe.ReadAsync($buffer,0,1)
  if(-not $read.Wait(4000)){throw 'Unauthorized caller rejection timed out'}
  if($read.Result -ne 0){throw 'Unauthorized process received a service reply'}
  $rejected=$true
 } catch [IO.IOException] {if(-not $connected){throw};$rejected=$true}
 catch [AggregateException] {if(-not $connected -or $_.Exception.InnerException -isnot [IO.IOException]){throw};$rejected=$true}
 finally {$pipe.Dispose()}
 if(-not $rejected){throw 'Unauthorized caller was not rejected'}
 Stop-TestApp
 Run-Installer $Installer
 $upgraded=Get-Service -Name WenBoxKvm
 try {$upgraded.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))} finally {$upgraded.Dispose()}
 Write-Output 'PASS: clean install, protected service data, wrong-image pipe rejection, in-place upgrade'
} finally {
 Stop-TestApp
 $uninstaller=Join-Path $root 'uninstall.exe'
 if(Test-Path -LiteralPath $uninstaller){Run-Installer $uninstaller}
}
if(Get-Service -Name WenBoxKvm -ErrorAction SilentlyContinue){throw 'Service remained after uninstall'}
if(Test-Path -LiteralPath $state){throw 'Privileged input state remained after uninstall'}
if(Get-NetFirewallRule -DisplayName 'WenBox KVM Control','WenBox KVM Input' -ErrorAction SilentlyContinue){throw 'KVM firewall rules remained after uninstall'}
Write-Output 'PASS: unified uninstall removed service, protected input state, and dedicated firewall rules'

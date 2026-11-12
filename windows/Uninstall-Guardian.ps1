$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请右键 Uninstall-Guardian.cmd，选择“以管理员身份运行”。'
}
$installDirectory = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'JustBlock'))
$expectedDirectory = [IO.Path]::GetFullPath(([Environment]::GetFolderPath('ProgramFiles')) + '\JustBlock')
if ($installDirectory -ne $expectedDirectory) { throw '安装路径校验失败，已取消。' }
$program = Join-Path $installDirectory 'JustBlock.exe'
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw '未找到保护程序。' }
& $program --prepare-uninstall
if ($LASTEXITCODE -ne 0) { throw '尚未解锁。请先在扩展中完成“解锁删改”，再运行卸载程序。' }
Stop-Service -Name JustBlockGuardian
& sc.exe delete JustBlockGuardian | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法移除 Windows 服务。' }
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
    try {
        foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
            $base.DeleteSubKey("SOFTWARE\$browser\NativeMessagingHosts\com.justblock.guardian", $false)
        }
    } finally { $base.Dispose() }
}
foreach ($name in @('native-host.json', 'JustBlock.exe', 'JustBlock.previous.exe')) {
    $file = Join-Path $installDirectory $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
}
# Keep the original hosts backup in ProgramData. Never overwrite unrelated hosts entries.
Write-Host '系统保护已移除，已清理 Just Block 的 hosts 条目。'
Write-Host '如果仍要单独使用扩展，请先移除扩展，再重新加载，以清除系统保护连接设置。'

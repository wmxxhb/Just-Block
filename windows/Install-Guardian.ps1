$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请右键 Install-Guardian.cmd，选择“以管理员身份运行”。'
}
$serviceName = 'JustBlockGuardian'
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw '系统保护程序已安装。请使用 Update-Guardian.cmd 升级，无需卸载。'
}
$installDirectory = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'JustBlock'
$dataDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'JustBlock'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$publicKey = [Convert]::FromBase64String($manifest.key)
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash($publicKey)
$alphabet = 'abcdefghijklmnop'
$extensionId = -join (0..15 | ForEach-Object { $alphabet[[int]($hash[$_] -shr 4)]; $alphabet[[int]($hash[$_] -band 15)] })
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
& icacls.exe $installDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法设置安装目录权限。' }
& icacls.exe $dataDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)R' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法设置配置目录权限。' }
[IO.File]::WriteAllText((Join-Path $dataDirectory 'owner.sid'), $identity.User.Value)
$program = Join-Path $installDirectory 'JustBlock.exe'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'JustBlock.exe') -Destination $program
$nativePath = Join-Path $installDirectory 'native-host.json'
$native = [ordered]@{
    name = 'com.justblock.guardian'
    description = 'Just Block Windows Guardian'
    path = $program
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($nativePath, $native, (New-Object Text.UTF8Encoding($false)))
New-Service -Name $serviceName -DisplayName 'Just Block Guardian' -BinaryPathName ('"' + $program + '" --service') -StartupType Automatic -Description 'Protects the Just Block website list and restores blocks when temporary access expires.' | Out-Null
try {
    Start-Service -Name $serviceName
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
        try {
            foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
                $key = $base.CreateSubKey("SOFTWARE\$browser\NativeMessagingHosts\com.justblock.guardian")
                try { $key.SetValue('', $nativePath, [Microsoft.Win32.RegistryValueKind]::String) }
                finally { $key.Dispose() }
            }
        } finally { $base.Dispose() }
    }
    & sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    Write-Host '安装完成。请重启浏览器一次，随后在扩展设置中点击“连接 Windows 保护程序”。'
    Write-Host '名单中的域名现在由系统 hosts 文件保护。只关闭扩展不会清除这些屏蔽条目。'
} catch {
    Write-Host '安装未完成。请查看错误信息；已创建的服务或 hosts 条目可能需要管理员手动处理。'
    throw
}

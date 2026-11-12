$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请右键 Update-Guardian.cmd，选择“以管理员身份运行”。'
}
$serviceName = 'JustBlockGuardian'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) { throw '尚未安装系统保护程序，请先运行 Install-Guardian.cmd。' }
$directory = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'JustBlock'
$program = Join-Path $directory 'JustBlock.exe'
$backup = Join-Path $directory 'JustBlock.previous.exe'
$replacement = Join-Path $PSScriptRoot 'JustBlock.exe'
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw '未找到原保护程序，已取消升级。' }
if (-not (Test-Path -LiteralPath $replacement -PathType Leaf)) { throw '升级包缺少 JustBlock.exe。' }
if ([IO.Path]::GetFullPath($replacement) -eq [IO.Path]::GetFullPath($program)) { throw '请从解压后的新版安装包运行升级。' }
Copy-Item -LiteralPath $program -Destination $backup -Force
try {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName }
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            Copy-Item -LiteralPath $replacement -Destination $program -Force
            break
        } catch {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 200
        }
    }
    Start-Service -Name $serviceName
    Write-Host '系统保护程序已升级。原屏蔽名单和保护配置已保留，正在进行的临时放行已结束。'
    Write-Host '请在浏览器扩展管理页重新加载新版扩展。无需卸载或重新连接保护程序。'
} catch {
    $failure = $_
    $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($current -and $current.Status -ne 'Stopped') { Stop-Service -Name $serviceName -ErrorAction SilentlyContinue }
    Copy-Item -LiteralPath $backup -Destination $program -Force
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
    throw "升级未完成，已尝试恢复原程序。$failure"
}

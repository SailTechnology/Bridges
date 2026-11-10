$ErrorActionPreference = 'Stop'
$bridgeRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$bridgeRunValues = Get-ItemProperty -LiteralPath $bridgeRunKey -ErrorAction SilentlyContinue
$bridgeValue = $bridgeRunValues.BridgesHost
if ($bridgeValue -and $bridgeValue.Contains($PSScriptRoot)) {
    Remove-ItemProperty -LiteralPath $bridgeRunKey -Name 'BridgesHost'
    Write-Output '已取消 Bridges 后台自启动。工程和会话记录仍保留。'
} else { Write-Output '没有属于此目录的 Bridges 自启动项。' }

$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
if ($bridgeRoot -notlike 'H:\*') { throw '安装路径必须位于 H: AI Workshop。' }
$bridgeRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$bridgeName = 'BridgesHost'
$bridgePowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$bridgeCommand = '"' + $bridgePowerShell + '" -NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Start-Bridges.ps1') + '" -NoBrowser'
$bridgeRunValues = Get-ItemProperty -LiteralPath $bridgeRunKey -ErrorAction SilentlyContinue
$bridgeOld = $bridgeRunValues.$bridgeName
if ($bridgeOld -and $bridgeOld -ne $bridgeCommand) {
    New-Item -ItemType Directory -Path (Join-Path $bridgeRoot 'runtime') -Force | Out-Null
    @{name=$bridgeName;value=$bridgeOld;at=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bridgeRoot ('runtime\autostart-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')) -Encoding UTF8
}
New-ItemProperty -LiteralPath $bridgeRunKey -Name $bridgeName -Value $bridgeCommand -PropertyType String -Force | Out-Null
Write-Output 'Bridges 已设为当前用户登录后后台启动。未更改电源和休眠设置。'

param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
if ($bridgeRoot -notlike 'H:\*') { throw 'Bridges 必须从 H: AI Workshop 启动。' }
$bridgeRuntime = Join-Path $bridgeRoot 'runtime'
$bridgeTemp = 'H:\Temp\Codex\Bridges'
New-Item -ItemType Directory -Path $bridgeRuntime,$bridgeTemp -Force | Out-Null
$env:TEMP = $bridgeTemp
$env:TMP = $bridgeTemp
$bridgeConfigPath = Join-Path $bridgeRuntime 'config.json'
if (-not (Test-Path -LiteralPath $bridgeConfigPath)) {
    Copy-Item -LiteralPath (Join-Path $bridgeRoot 'config.example.json') -Destination $bridgeConfigPath
}
$bridgeConfig = Get-Content -LiteralPath $bridgeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgePort = [int]$bridgeConfig.port
try {
    $bridgeHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/health" -TimeoutSec 2
    if ($bridgeHealth.service -eq 'neo-win-bridges') {
        if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$bridgePort/" }
        Write-Output "Bridges 已在运行：http://127.0.0.1:$bridgePort/"
        exit 0
    }
} catch { }
$bridgeNode = 'H:\Runtimes\node-v24.22.1-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $bridgeNode)) { $bridgeNode = (Get-Command node -ErrorAction Stop).Source }
$bridgeCodex = (Get-Command codex -ErrorAction Stop).Source
$bridgeConfig.codexExecutable = $bridgeCodex
$bridgeConfig | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $bridgeConfigPath -Encoding UTF8
$bridgeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bridgeOut = Join-Path $bridgeTemp "host-$bridgeStamp.stdout.log"
$bridgeErr = Join-Path $bridgeTemp "host-$bridgeStamp.stderr.log"
$bridgeArgs = '"{0}" --config "{1}"' -f (Join-Path $bridgeRoot 'src\server.mjs'), $bridgeConfigPath
$bridgeProcess = Start-Process -FilePath $bridgeNode -ArgumentList $bridgeArgs -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr
for ($bridgeAttempt = 0; $bridgeAttempt -lt 24; $bridgeAttempt++) {
    Start-Sleep -Milliseconds 500
    if ($bridgeProcess.HasExited) { throw "Bridges 启动失败，请查看 $bridgeErr" }
    try {
        $bridgeHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/health" -TimeoutSec 1
        if ($bridgeHealth.service -eq 'neo-win-bridges') {
            if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$bridgePort/" }
            Write-Output "Bridges 已启动：http://127.0.0.1:$bridgePort/"
            exit 0
        }
    } catch { }
}
throw "Bridges 未在预期时间内就绪，请查看 $bridgeOut 和 $bridgeErr"

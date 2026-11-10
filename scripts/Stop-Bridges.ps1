$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeConfig = Get-Content -LiteralPath (Join-Path $bridgeRoot 'runtime\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgePort = [int]$bridgeConfig.port
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$bridgePort/api/admin/shutdown" -Headers @{'X-Bridges-Client'='1'} -ContentType 'application/json' -Body '{}' -TimeoutSec 5

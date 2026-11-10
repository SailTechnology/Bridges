$ErrorActionPreference = 'Continue'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeConfig = Get-Content -LiteralPath (Join-Path $bridgeRoot 'runtime\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgePort = [int]$bridgeConfig.port
try {
    $bridgeStatus = Invoke-RestMethod "http://127.0.0.1:$bridgePort/api/status" -TimeoutSec 5
    $bridgeStatus | Select-Object version,host,codexReady,lastPoll,error,contextMode,dataRoot,neo | ConvertTo-Json -Depth 5
} catch { Write-Output ('Bridges HTTP: ' + $_.Exception.Message) }
Get-Command node,codex,ssh -ErrorAction SilentlyContinue | Select-Object Name,Source
$bridgeTs = Get-Command tailscale -ErrorAction SilentlyContinue
if ($bridgeTs) {
    $bridgeNet = & $bridgeTs.Source status --json | ConvertFrom-Json
    [pscustomobject]@{Tailscale=$bridgeNet.BackendState;Host=$bridgeNet.Self.HostName;DNS=$bridgeNet.Self.DNSName;IPs=$bridgeNet.Self.TailscaleIPs;Peers=@($bridgeNet.Peer.PSObject.Properties.Value | Select-Object HostName,OS,Online)} | ConvertTo-Json -Depth 5
    & $bridgeTs.Source serve status
}
Write-Output '诊断不会输出 API Key、Cookie 或配对凭据。'

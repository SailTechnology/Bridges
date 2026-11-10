$ErrorActionPreference = 'Stop'
$bridgeTs = (Get-Command tailscale -ErrorAction Stop).Source
$bridgeStatus = & $bridgeTs serve status --json | ConvertFrom-Json
if ($bridgeStatus.TCP.PSObject.Properties.Name -contains '8443') {
    $bridgeHandlers = $bridgeStatus.Web.PSObject.Properties | Where-Object Name -like '*:8443' | ForEach-Object { $_.Value.Handlers.'/' }
    if (-not ($bridgeHandlers | Where-Object { $_.Proxy -eq 'http://127.0.0.1:8877' })) {
        throw 'Tailscale 8443 已被其他服务使用，未修改既有设置。'
    }
}
& $bridgeTs serve --bg --https=8443 http://127.0.0.1:8877
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve 未启用，请按终端的官方启用地址处理。' }
& $bridgeTs serve status

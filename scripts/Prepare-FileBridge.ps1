# Prepare a project-specific file/build endpoint. Does not start a service, enable networking, or log in.
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
if ($bridgeRoot -notlike 'H:\*') { throw '工作文件必须位于 H: AI Workshop。' }
$bridgeRuntime = Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Path $bridgeRuntime -Force | Out-Null
$bridgeConfigPath = Join-Path $bridgeRuntime 'config.json'
if (Test-Path -LiteralPath $bridgeConfigPath) {
    Copy-Item -LiteralPath $bridgeConfigPath -Destination (Join-Path $bridgeRuntime ('config-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'))
}
$bridgeConfig = Get-Content -LiteralPath (Join-Path $bridgeRoot 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgeBuilder = 'H:\Projects\小飞象章鱼仿生\地面站\packaging\macos\build_macos.py'
$bridgeConfig.profileId = 'windows-file-delivery'
$bridgeConfig.allowedProjects = @('小飞象章鱼仿生')
$bridgeConfig.enableCodex = $false
$bridgeConfig.readOnly = $true
$bridgeConfig.allowBuilds = $true
$bridgeConfig.buildRecipes.'octopus-groundstation'.enabled = $true
$bridgeConfig.buildRecipes.'octopus-groundstation'.builderSha256 = (Get-FileHash -LiteralPath $bridgeBuilder -Algorithm SHA256).Hash.ToLowerInvariant()
$bridgeConfig | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $bridgeConfigPath -Encoding UTF8
Write-Output '已准备：只读访问小飞象章鱼工程，并允许在 H:\Temp\Codex\Bridges 中构建 Mac 部署包。'
Write-Output '没有启动服务、修改账号、同步会话或启用远程网络。'
Write-Output ('配置位置：' + $bridgeConfigPath)

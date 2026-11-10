# Neo 与 Windows 工程联动

目标：在 Neo 上对 GPT 说“部署今天的章鱼地面站”，由 GPT 调用 Windows 上的原工程和构建工具，在 Windows 完成处理，再把最终部署包下载到 Neo 校验、安装和启动。

源工程留在 Windows。这个流程不需要全量同步工程，也不依赖 NAS。两端的 GPT 各用自己的登录状态；文件工具不登录 GPT、不转发模型请求，也不复制账号凭据或聊天数据库。

## 本次交付状态

- 完成了工程文件按需读取、固定构建任务、异步查询、部署包下载和 SHA-256 校验接口。
- Neo 客户端使用 macOS 自带的 Bash、curl、plutil 和 ditto，提供 `deploy octopus-groundstation` 一个部署入口。
- 实际在独立的 H: 目录构建了章鱼地面站 v0.8.4：1105 个输入文件通过构建后校验，部署包约 174.4 MB。没有改动原工程和原发布包。
- 已通过 Windows 文件工具实际提交构建并校验部署包，支持深层任务目录中的长路径；原始工程与账号数据未上传。
- Windows 服务、Tailscale Serve 和自启动分别按首次配对说明启用。
- Neo 尚未配对，Mac 上的安装和启动尚未实测。

## 入口

- 公开仓库：`https://github.com/SailTechnology/Bridges`
- [交给 Neo 上 GPT 的说明](docs/给Neo上的GPT.md)
- [首次配对与日常部署](docs/首次配对与日常部署.md)
- [本次检查记录](docs/验证记录_20261110.md)

Neo 首次获取工具（可以匿名克隆，无需登录 GitHub）：

```bash
mkdir -p ~/Projects/Bridges
git clone https://github.com/SailTechnology/Bridges.git ~/Projects/Bridges/接入工具
```

工具更新：

```bash
git -C ~/Projects/Bridges/接入工具 pull --ff-only
```

日常部署：

```bash
/bin/bash ~/Projects/Bridges/接入工具/macos/bridges-client.sh deploy octopus-groundstation
```

首次需要 Windows 启动文件工具、两端加入同一个私人 Tailscale 网络，并配对一次。此后 GPT 可以独立调用该命令。配对过期时需要重新配对。

## 数据位置与隔离

| 内容 | 位置 |
|---|---|
| Windows 源工程 | 原有 `H:\Projects\小飞象章鱼仿生`，作为构建输入 |
| Windows 构建和日志 | `H:\Temp\Codex\Bridges\builds\<配置>\<任务ID>` |
| Windows 任务状态 | `H:\Projects\Bridges\runtime\profiles\<配置>` |
| Windows 配对凭据 | `C:\Users\Sail\.codex\bridges\<配置>`，不放入交付包 |
| Neo 配对凭据 | `~/Library/Application Support/Bridges/profiles/<配置>` |
| Neo 下载与各版应用 | `~/Projects/Bridges/profiles/<配置>/deployments/<任务ID>` |

每个端点使用独立配置和 Cookie。更换 Windows 地址必须创建新配置。构建输出使用新任务目录，Neo 安装也使用新目录，旧应用和应用数据保留。

`src/context.mjs` 等文件还保留了早期的 Codex 会话接续原型。这一功能默认关闭、只读，当前文件部署流程不会连接 Codex 账号或同步对话。官方云端工作区接入也未启用。

## 开发验证

Node.js 24，零 npm 依赖。Windows 测试使用已有 `H:\Runtimes\MigrationPython\python.exe`。

```powershell
node --test tests/*.test.mjs
```

构建脚本通过 SHA-256 绑定。脚本改动后需重新核对其行为，再更新绑定；服务不会自动执行变化后的脚本。

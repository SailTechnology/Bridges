# 给 Neo 上 GPT 的任务说明

请协助我接入已经在 Windows 准备的工程文件工具。我的目标是：以后我说“部署今天的章鱼地面站”，你在 Windows 上读取必要文件、发起构建并等待完成，仅下载最终的 Mac 部署包，在 Neo 上校验、安装和启动。

请使用你在 Neo 上正常登录的账号。不要复制 Windows 的 GPT/Codex 登录文件、API Key、聊天数据库或浏览器数据；不要上传原工程到任何云端工作区。Windows 原工程是重要数据，保持它作为只读输入。

## 本次已提供

- `macos/bridges-client.sh`：工具客户端，使用 macOS 自带命令，无需安装 Python、Node、Homebrew 或新模型后端。
- `docs/首次配对与日常部署.md`：Windows 首次准备与配对方式。
- 可用任务标识：`octopus-groundstation`，构建章鱼地面站 Apple Silicon 版。

Windows 位置为 `H:\Projects\Bridges`，源工程为 `H:\Projects\小飞象章鱼仿生\地面站`。

## 你先做的事情

1. 从公开 GitHub 仓库拉取工具到 `~/Projects/Bridges/接入工具`，无需登录 GitHub。若目录已存在，先检查它的 Git 远程和本地改动，再使用 `git pull --ff-only`；不要覆盖已有目录或丢弃本地改动。没有安装 Git 时，先通过官方方式准备 Git，由我处理首次系统安装提示。ZIP 方式也仍可使用。
2. 检查 Tailscale 是否已安装，并让 Neo 加入我自己的私人网络。登录和首次系统授权由我完成；不要自行更换账号、扩大网络访问范围或修改系统安全策略。
3. 获取 Windows 文件工具的实际地址，检查 Windows 端已按说明启动服务并启用私网 HTTPS。参考主机名是 `sailstation.tail416821.ts.net`，可用端口须由 Windows 的实际输出确认，不要猜测已启用。
4. 用 `bridges-client.sh setup <地址>` 配对。在 Windows 本机页面生成一次性码，由我输入；不要把验证码和 Cookie 放进聊天输出。
5. 调用 `status`、`projects`、`deployables`，确认只提供已授权的工程，`accountConnected` 为 false，`octopus-groundstation` 已启用。

首次拉取命令：

```bash
mkdir -p ~/Projects/Bridges
git clone https://github.com/SailTechnology/Bridges.git ~/Projects/Bridges/接入工具
```

公开仓库支持匿名拉取；连接 Windows 文件工具仍需单独配对。不要复制 Windows 的 GitHub 凭据。工具包更新可使用：

```bash
git -C ~/Projects/Bridges/接入工具 pull --ff-only
```

## 我说“部署今天的地面站”之后

直接调用：

```bash
/bin/bash ~/Projects/Bridges/接入工具/macos/bridges-client.sh deploy octopus-groundstation
```

它会在 Windows 新目录构建，等待结果，只下载成品 ZIP，校验 SHA-256，解压到新的版本目录，再在本地没有旧地面站服务时请求启动。不要先把整个工程传来 Neo，不要在 Neo 重新构建全部工程。

如果需要了解文件，先调用 `projects` 取得工程 ID，再调用 `files <工程ID> <相对目录>` 或 `read <工程ID> <相对文件>`。如果缺少新的构建任务，请先说明所需输入和操作，不要用远程任意命令执行来绕开任务清单。

每次完成后，报告 Windows 构建版本和任务 ID、部署包校验结果、Neo 安装位置，以及本机页面是否实际打开。已请求启动不等于已成功启动；需要观察地面站健康接口或页面。

旧地面站服务已运行时，脚本会保留新版本并暂缓启动第二个服务。请检查设备连接和运动状态，再决定如何停止旧服务。首次出现 macOS 应用放行提示时由我处理，不要关闭 SIP 或全局绕过 Gatekeeper。

保留原工程、旧应用和应用数据。不要把这个工具的配对 Cookie 与 GPT 登录凭据混用。

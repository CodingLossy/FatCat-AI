# FatCat-AI

[English](README.en.md) · 源码:<https://github.com/CodingLossy/FatCat-AI> · 问题反馈:<https://github.com/CodingLossy/FatCat-AI/issues>

一个真正属于你自己的 AI 助手:可自托管、开源、自带模型(BYO LLM)、本地优先、**零遥测**、插件化(MCP 为一等公民)。

> 当前状态:**M4 · 语音与图片**(预发布,尚未打版本)。在 M3 的邮件、工具、本地文件、知识库与长期记忆之上,增加了语音与图片:按住说话转写、回复朗读、语音状态指示器,以及在对话里发送图片给支持看图的模型(语音与看图都经你配置的 OpenAI 兼容端点,密钥只留在服务器上)。可用 Web UI / 命令行 / curl。更新记录见 [CHANGELOG.md](CHANGELOG.md),开发计划见 [docs/plan/FatCat-AI-开发计划.md](docs/plan/FatCat-AI-开发计划.md)。

## 特性(规划中)

- **BYO LLM**:任何 OpenAI 兼容端点(含 Ollama / LM Studio / vLLM),另支持 Anthropic / Gemini 原生接口。已确认可用的端点:DeepSeek(`https://api.deepseek.com/v1`)、OpenRouter(`https://openrouter.ai/api/v1`)
- **Headless 核心**:所有能力都通过版本化的 `/api/v1` HTTP + WebSocket API 提供,Web UI、CLI、IM 渠道都是它的客户端
- **本地文件、邮件、语音、定时任务**,工具按风险分级,危险操作默认需人工确认
- **渠道**:1.0 支持企业微信与微信
- **知识地图**:邮件、文档、小说、人物等汇入统一条目索引,可逐层钻取浏览
- **长期记忆**:有类型、可更替、带出处;回答时附可信度说明(可靠 / 可能过时 / 有冲突 / 推断);凭据一律拒存,敏感信息写入前脱敏;可以反馈「有用 / 过时 / 错误 / 不该记」,也可以随时忘记
- **轻量**:2GB 内存的服务器即可常驻运行

## 零遥测承诺

FatCat-AI **不包含任何**统计或崩溃上报代码。程序只会连接你配置的模型端点、邮箱、渠道和插件,以及(可关闭的)GitHub Releases 更新检查。

## 快速开始

需要 Node.js 24 LTS 或更高版本与 pnpm 10(`corepack enable` 即可启用)。M1 可以:接入任意 OpenAI 兼容端点(含 Ollama / DeepSeek / OpenRouter)以及 Anthropic、Gemini 原生接口流式对话,刷新页面后续看进行中的回复,让助手记住你说的事(普通事实直接记住、可以撤销,涉及敏感信息或更替画像时需要你批准),并用 Web UI、命令行或 curl 使用。

### 1. 启动

模型密钥只从环境变量或本地文件读取,不能在页面或 API 里填写明文。

macOS / Linux:

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
export DEEPSEEK_API_KEY='<你的密钥>'   # 示例用 DeepSeek;本地 Ollama 不需要密钥
pnpm dev
```

Windows(PowerShell):

```powershell
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
$env:DEEPSEEK_API_KEY = '<你的密钥>'
pnpm dev
```

- 核心服务:<http://127.0.0.1:8787/healthz>
- Web UI:<http://127.0.0.1:5173>。按提示创建主人账户(1.0 只有一个账户),到「设置 → 模型配置档」添加配置档,密钥引用填 `env:DEEPSEEK_API_KEY`(本地 Ollama 留空),看到「密钥: 已设置」后就可以开始对话。
- 本地运行时核心服务默认不托管 Web UI:没有设置 `FATCAT_AI_WEB_DIR` 时,<http://127.0.0.1:8787/> 返回 404,这是正常的,`pnpm dev` 下请用 5173 端口。想让 8787 端口直接提供 Web UI(例如 `pnpm build` 后用 `pnpm --filter @fatcat-ai/server start` 运行,它会同时带上内存参数 `--max-semi-space-size=8`),先把 `FATCAT_AI_WEB_DIR` 设为 `apps/web/dist` 的绝对路径。Docker 镜像已经设置好。

不想用环境变量时,也可以把密钥写进数据目录(默认 `~/.fatcat-ai`,Windows 为 `%USERPROFILE%\.fatcat-ai`)下的 `secrets.yaml`,每行一个 `NAME: value`,配置档里引用 `file:NAME`。文件修改后立即生效,不需要重启。服务器自己写入这个文件时(例如微信登录令牌),在 Windows 上会去掉继承来的访问项,只保留当前用户的完全控制;做不到时记一条警告,文件仍会留下。

**加密密钥文件**(可选,需要你明确确认,不会自动进行):在「设置 → 密钥」点「加密密钥文件」,或停服后运行 `node dist/index.js secrets migrate`。服务器会先备份、把 `secrets.yaml` 加密为 `secrets.yaml.enc`(AES-256-GCM)、解密回读逐个核对,全部通过后才把明文改名为 `secrets.yaml.migrated`;确认一切正常后用 `node dist/index.js secrets cleanup` 删除它。主密钥按优先级取:环境变量 `FATCAT_MASTER_KEY`(64 位十六进制或 base64)→ `FATCAT_MASTER_KEY_FILE` 指向的文件 → 数据目录里自动生成的 `master.key`(权限 600,Windows 上只给当前用户)。前两种格式不对时启动报错,不会悄悄换成下一种。**丢失主密钥等于丢失全部密钥**(模型 key 重新填写,微信重新扫码);主密钥不进备份。拿到整个数据目录(含 `master.key`)的人仍能解密,所以公网部署请把主密钥放在环境变量或容器 secret 里。换主密钥:停服后 `node dist/index.js secrets rekey --new-key-file <文件>`(不接受命令行里直接写密钥)。没有任何密钥文件的全新安装,第一次写入密钥(例如微信登录令牌)时直接写加密文件;明文与加密文件同时存在时启动报错。

> 本项目原名 AI-Personal。升级后服务器首次启动会把旧的 `~/.ai-personal` 自动迁到 `~/.fatcat-ai`(已有新目录时不覆盖);旧的 `AIP_*` 环境变量暂时仍可用,但会提示改用 `FATCAT_AI_*`。

### 2. Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

镜像同时托管 Web UI:<http://127.0.0.1:8787>。数据(含 `secrets.yaml`)在 `/data` 卷中,可以这样写入密钥,然后在配置档里引用 `file:DEEPSEEK_API_KEY`:

```bash
printf 'DEEPSEEK_API_KEY: "%s"\n' '<你的密钥>' | \
  docker compose -f docker/docker-compose.yml exec -T fatcat-ai sh -c 'umask 077; cat > /data/secrets.yaml'
```

> 从 AI-Personal 升级:compose 服务名由 `ai-personal` 改为 `fatcat-ai`,数据卷 `ai-personal-data` 不变,数据不受影响。升级前先用旧版的 compose 文件执行 `docker compose -f docker/docker-compose.yml down`,或者升级后用 `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans` 启动;否则旧容器会继续运行并占着 8787 端口,新容器无法启动。

默认只监听 127.0.0.1;从其他机器访问请经反向代理并启用 HTTPS。从其他机器或经过反向代理初始化时,需要启动日志里打印的一次性设置码(`docker compose -f docker/docker-compose.yml logs`)。

### 3. 用 curl 完成一次对话(不开 Web UI)

所有功能都在版本化的 `/api/v1` 里,OpenAPI 文档在 `/api/v1/openapi.json`(需要鉴权)。下面的例子先用密码初始化,再换成个人访问令牌,之后的请求都带 `Authorization: Bearer`,不需要 CSRF 令牌。

```bash
API=http://127.0.0.1:8787/api/v1

# 初始化主人账户(本机直连不需要设置码);会话 Cookie 存进 jar.txt
curl -s -c jar.txt -X POST $API/auth/setup -H 'content-type: application/json' \
  -d '{"username":"owner","password":"correct horse battery staple"}' > setup.json
CSRF=$(sed -E 's/.*"csrfToken":"([^"]+)".*/\1/' setup.json)

# 换取个人访问令牌(明文只返回这一次)
TOKEN=$(curl -s -b jar.txt -X POST $API/tokens -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"curl"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
AUTH="authorization: Bearer $TOKEN"

# 添加模型配置档;返回的 keyStatus 为 present 表示服务器读到了密钥
curl -s -X POST $API/models -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"deepseek","kind":"openai-compatible","baseURL":"https://api.deepseek.com/v1","apiKeyRef":"env:DEEPSEEK_API_KEY","model":"deepseek-flash","purpose":["chat","cheap"]}'

# 新建会话并发送消息;-N 让回复按 SSE 事件流式输出
SID=$(curl -s -X POST $API/sessions -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -N -X POST $API/sessions/$SID/messages -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"记住:我住在杭州"}'
```

当事件流里出现 `approval-required`(例如模型想调用 `memory.save` 写入记忆),运行会暂停,等你在另一个终端里批准或拒绝:

```bash
curl -s -X POST $API/approvals/<callId> -H "$AUTH" -H 'content-type: application/json' -d '{"decision":"approve"}'
```

断线后可以续看同一次运行:`curl -N $API/runs/<runId>/events -H "$AUTH" -H 'last-event-id: 0'`。

Windows PowerShell 中的同一流程(流式部分用系统自带的 `curl.exe`):

```powershell
$api = 'http://127.0.0.1:8787/api/v1'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$setup = Invoke-RestMethod -Method Post "$api/auth/setup" -WebSession $s -ContentType 'application/json' `
    -Body '{"username":"owner","password":"correct horse battery staple"}'
$tok = Invoke-RestMethod -Method Post "$api/tokens" -WebSession $s -Headers @{ 'X-CSRF-Token' = $setup.csrfToken } `
    -ContentType 'application/json' -Body '{"name":"powershell"}'
$h = @{ Authorization = "Bearer $($tok.token)" }
Invoke-RestMethod -Method Post "$api/models" -Headers $h -ContentType 'application/json' -Body (@{
    label = 'deepseek'; kind = 'openai-compatible'; baseURL = 'https://api.deepseek.com/v1'
    apiKeyRef = 'env:DEEPSEEK_API_KEY'; model = 'deepseek-flash'; purpose = @('chat', 'cheap')
} | ConvertTo-Json)
$sid = (Invoke-RestMethod -Method Post "$api/sessions" -Headers $h -ContentType 'application/json' -Body '{}').id
'{"text":"Hello"}' | curl.exe -N -X POST "$api/sessions/$sid/messages" -H "Authorization: Bearer $($tok.token)" `
    -H 'content-type: application/json' --data-binary '@-'
```

### 4. 命令行客户端

不需要 Web UI 也能完成初始化与对话(`pnpm build` 后在仓库根目录运行 `node apps/cli/dist/bin.js …`,下面示例中的 `fatcat-ai` 都可以这样替换):

```bash
fatcat-ai setup -u owner          # 创建主人账户并保存个人访问令牌(~/.fatcat-ai/cli.json,权限 0600)
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "用三句话解释 AGPL 第 13 条"
fatcat-ai chat                    # 交互式聊天:/new /model /retry /exit,Ctrl+C 中断当前回复
```

Anthropic / Gemini 用 `--kind anthropic` 或 `--kind gemini`(不需要 `--base-url`)。需要审批的工具调用(如 `memory.save`)会在终端里询问,非交互时默认拒绝,除非加 `--approve-tools`。

### 5. 接入微信

1. 设置 → 渠道:添加一个微信渠道并启用,点「扫码登录」,用要当作助手的微信账号扫码并在手机上确认。
2. 登录令牌保存在数据目录的 `secrets.yaml`(键名 `ILINK_TOKEN_<渠道 id>`)。服务器写入前会把原文件复制到 `backups/secrets-<UTC 时间>.yaml`(密钥文件已加密时是 `.yaml.enc`,密文原样备份)(权限 600,只保留最近 5 份),只改这一行;`secrets.yaml` 解析失败时不写入。在 Windows 上写完后会去掉继承来的访问项,只给当前用户完全控制。删除渠道时同样只删这一行。
3. 点「生成配对码」,用你自己的微信私聊助手账号发送「绑定 123456」。之后只有你的私聊消息会进入对话;需要确认的操作回复「确认 K7」或「拒绝 K7」。发送 `/clear` 或「清空」只清空这个渠道的当前会话,记忆不会删除。Web 的会话列表可以删除单条对话,或「清空全部对话」(同样保留记忆)。
4. 登录失效时渠道显示「需要扫码登录」,重新扫码即可。暂不支持图片、文件和需要输入 PIN 的登录。

### 开发

`pnpm lint`、`pnpm typecheck`、`pnpm test`(Vitest)、`pnpm build` 后运行 `pnpm test:e2e`(Playwright 冒烟,首次需 `pnpm --filter @fatcat-ai/web exec playwright install chromium`)。完整约定见 [AGENTS.md](AGENTS.md),更新记录见 [CHANGELOG.md](CHANGELOG.md)。

参与开发请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

FatCat-AI 采用双许可:

- **开源版**:[GNU AGPL-3.0](LICENSE)(`AGPL-3.0-only`)。你可以自由使用、修改和分发,包括商业用途,但如果你分发修改版或**通过网络向他人提供修改版服务**,必须以 AGPL-3.0 公开相应的完整源代码。
- **商业许可**:如果你希望在闭源产品或服务中使用、内嵌或修改 FatCat-AI 而不承担 AGPL 的开源义务,请参阅 [COMMERCIAL.md](COMMERCIAL.md) 联系作者获取商业许可。

插件 SDK(`@fatcat-ai/plugin-sdk`)与客户端 SDK(`@fatcat-ai/client`)以 [Apache-2.0](packages/plugin-sdk/LICENSE) 发布。

贡献代码前需签署 [CLA](CLA.md)(PR 中会自动提示)。「FatCat-AI」名称与 Logo 为作者商标,见 [TRADEMARKS.md](TRADEMARKS.md)。商业许可联系:x19169738916@163.com。

Copyright (C) 2026 尹绪柏 (Theodore Yin)

# ADR 0008 · 客户端 SDK(packages/client)与命令行(apps/cli)

- 状态:提议(M1 PR #7 `feat/client-cli`,待业主审阅)
- 日期:2026-11-04
- 来源:开发计划 6.1;`docs/milestones/M1-plan.md` 第 1、5、6 节;ADR 0004(API v1 约定)

## 背景

计划 6.1 要求 M1 就能「不开 Web UI,用 CLI / curl 完成一次完整对话(及审批)」。Web UI(PR #8)和以后的桌面、移动端也都只能走公开 API,所以先做一个所有客户端共用的 TypeScript SDK,再在它之上做最小命令行。

## 决定

### 1. packages/client(Apache-2.0)

- **零运行时依赖**:只用平台自带的 `fetch`、`ReadableStream`、`TextDecoder`、`WebSocket`(Node ≥ 22 与浏览器都有)。对 `@fatcat-ai/shared` 只做 `import type`,构建产物不在运行时加载 zod,CLI 启动与以后的浏览器打包都更轻。
- **入口** `createClient({ baseUrl, token?, csrfToken?, fetch?, WebSocket? })`,按资源分组:`auth`、`tokens`、`models`、`settings`、`sessions`、`runs`、`approvals`、`memory`,与 `/api/v1` 端点一一对应,不加任何内部捷径。
- **鉴权**:给了 `token` 时发 `Authorization: Bearer aip_pat_…`;否则按浏览器方式带 Cookie(`credentials: 'include'`),修改类请求附 `X-CSRF-Token`(`csrfToken` 可为字符串或返回字符串的函数)。
- **错误**:非 2xx 一律抛 `FatCatApiError`,带 `status` 与解析出的 problem details;未知 `code` 不做特殊处理(ADR 0004 第 3 节)。错误消息里不包含请求头。
- **SSE 与续看**(`sse.ts`):`sessions.send()` / `regenerate()` / `runs.retry()` / `runs.events()` 返回 `RunStream`(`AsyncIterable<EventEnvelope>`)。流在收到 `run-finished` / `run-failed` 前断开时,自动用 `Last-Event-ID: <最后的 seq>` 请求 `GET /runs/:id/events` 续看,按 seq 去重;退避 0.5 s 起翻倍、上限 8 s,默认最多重连 5 次。`send()` 未传 `clientMessageId` 时自动生成一个,即使在收到 `run-started` 前就断开,重发也只会得到同一个运行(ADR 0004 第 6 节)。未知事件类型原样交给调用方,由调用方忽略。
- **WebSocket**(`ws.ts`):`connectEvents({ onEvent, lastSeq? })` 发送 `hello`(`protocolVersion` + `lastSeq`),断线后带已收到的最大 seq 自动重连并补发;对 4406(协议版本不支持)不重连。Node 中通过构造参数的 `headers` 传 Bearer 令牌(令牌不放 URL,ADR 0004 第 5 节);浏览器依赖同源 Cookie。
- **令牌换取**(仅 Node):`auth.loginForToken()` / `auth.setupForToken()` 用密码登录(或初始化)得到会话 Cookie,立即用它创建个人访问令牌,再登出该 Cookie 会话,只返回令牌。浏览器读不到 `Set-Cookie`,所以这两个方法只给 CLI 等非浏览器客户端用。

### 2. apps/cli(AGPL-3.0-only,bin `fatcat-ai`)

- **不用 citty**:M1 方案原列了 citty,实际命令很少,改用 Node 内置的 `node:util` `parseArgs`,不新增任何第三方依赖。
- 命令:`setup`、`login`、`logout`、`whoami`、`chat`、`ask`、`sessions list|show`、`models list|add|test`、`memory list|search|add|edit|forget`、`approve`、`serve`。`memory add` 走 `POST /memory`(来源为用户明确要求,不需要审批),凭据照样被服务器拒存。
- **配置**:优先级为命令行参数 > 环境变量 `FATCAT_AI_SERVER` / `FATCAT_AI_TOKEN` > `~/.fatcat-ai/cli.json`(目录 0700、文件 0600;`FATCAT_AI_CLI_CONFIG` 可改路径,供测试与多环境使用)。文件里只有服务器地址、令牌与令牌 id;令牌从不打印到 stdout / stderr。命令行参数只有 `--server`,**令牌不接受命令行参数**(会留在 shell 历史和进程列表里),只走环境变量或配置文件。文件中的令牌只用于文件中记录的那个服务器,`--server` 指向别处时不会带过去。
- **密码输入**:终端里静默读取;非终端必须显式用 `--password-stdin`,不接受命令行参数传密码(会留在 shell 历史和进程列表里)。
- **输出**:stdout 只输出回复正文(`--json` 时每行一个 EventEnvelope),状态、工具调用、错误一律写 stderr,便于管道。
- **审批默认拒绝**:收到 `approval-required` 时,交互终端里询问(默认 N);非交互时自动拒绝并在 stderr 说明,只有显式 `--approve-tools` 才自动批准(AGENTS.md 第 7 条:默认需审批)。另有 `fatcat-ai approve <callId> [--reject]` 供脚本使用。
- **中断**:`chat` 中 Ctrl+C 取消当前运行(`POST /runs/:id/cancel`),空闲时再按一次退出;`ask` 中 Ctrl+C 取消运行后退出。
- **`serve`**:设置 `FATCAT_AI_HOST` / `FATCAT_AI_PORT` / `FATCAT_AI_DATA_DIR` 后直接加载 `@fatcat-ai/server` 的入口,与 `pnpm --filter @fatcat-ai/server start` 等价。
- **容器内存**:Docker 镜像只安装 `@fatcat-ai/server...` 依赖树,CLI 与 SDK 不进入镜像,不影响 120 MiB 空闲门禁。

### 3. 验证

- `packages/client` 单测:SSE 解析(分块、多行 data、注释心跳、CRLF)、断线续看去重、错误映射、鉴权头。
- `apps/cli` 端到端测试:启动真实构建的 server(临时数据目录、随机端口)和一个回放合成 fixture 的 OpenAI 兼容假端点,依次运行 `setup` → `models add` → `ask` → `sessions list/show`,以及带审批的 `memory.save` 往返(拒绝与批准两条路径),全程不打开 Web UI。

## 后果

- Web UI 在 PR #8 直接用这个 SDK,不会出现第二套请求代码。
- SDK 不在运行时校验响应结构(信任同版本服务器);以后若需要,可在 shared 的 zod schema 上加可选校验,不改接口。
- 待业主决定:是否把 SDK 以 `@fatcat-ai/client` 名义发布到 npm(目前 `private: true`,M1 不发布)。

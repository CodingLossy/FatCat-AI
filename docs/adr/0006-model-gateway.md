# ADR 0006 · 模型网关:ModelProvider 接口、密钥来源与脱敏

- 状态:已采纳(M1 实施方案,业主 2026-11-03 确认);第 5 节为 `feat/native-providers` 新增,待业主审阅
- 日期:2026-11-03
- 来源:开发计划第 1.4 节(BYO LLM)、3.5、第 6 节;`docs/milestones/M1-plan.md` 第 2 节
- 契约代码:`packages/shared/src/models.ts`;实现:`packages/providers`

## 背景

用户自带模型:任何 OpenAI 兼容端点(含 Ollama、LM Studio、vLLM、DeepSeek 等),以及 Anthropic / Gemini 原生接口。AI SDK 等依赖迭代很快,上层(agent、server)不能直接依赖它们的类型。密钥是最敏感的数据,来源和出口都必须受控。

## 决定

### 1. 自有接口与自写的 OpenAI 兼容客户端

`packages/providers` 对外只暴露 `ModelProvider`(`stream()` 产出 `ChatChunk` 异步序列,`test()` 做连接测试)、`createProvider(profile, deps)` 与 `selectProfile(profiles, 'chat' | 'cheap', defaults)`。接口签名见 M1 方案第 2.1 节。

**实现(PR #4 调整):OpenAI 兼容端点直接用 `fetch` + `ReadableStream` 实现,不引入 SDK。** 实测 Vercel AI SDK 7(`ai` + `@ai-sdk/openai-compatible`)仅 `import` 就增加约 22 MiB RSS,而容器空闲门禁是 120 MiB(当前约 92 MiB)。OpenAI 兼容协议只需要一个 POST 加 SSE 解析,自写约 300 行即可覆盖流式文本、工具调用、usage、错误与重试,零新增运行时依赖。Anthropic / Gemini 原生适配(M1 最后一个 PR)届时再测内存:如果用 SDK,只在用户配置了对应类型的配置档时才动态加载。(已在第 5 节落地:同样用 `fetch` 自写,没有引入 SDK。)

- 中断:`ChatRequest.signal`;取消后产出 `finish { reason: 'aborted' }`。
- 重试:只对连接错误、429、5xx 做一次退避重试,且只在尚未输出任何 token 时重试。
- 首 token 超时默认 60 秒(可配置)。
- 没有 cheap 配置档时回退到 chat 配置档。
- 上游错误归类为 `ProviderErrorCode`(`auth_failed` / `not_found` / `rate_limited` / `timeout` / `bad_request` / `upstream_error` / `network_error`),对外通过 problem+json 的 `providerCode` 字段返回(ADR 0004)。

### 2. 配置档与密钥引用

- 配置档(`model_profiles` 表)只保存 **`apiKeyRef`**,不保存明文:
  - `env:NAME`:读环境变量 `NAME`;
  - `file:NAME`:读数据目录下 `secrets.yaml` 中的 `NAME` 键;文件权限宽于 0600 时启动报警(Windows 上检查 ACL 不可行,只给出文档提示);
  - `null`:不需要密钥(如本机 Ollama)。
- **API 与 Web UI 不接收明文密钥**(业主决定)。服务器端加密存储推迟到 M5。
- `GET /api/v1/models` 返回 `apiKeyRef` 与 `keyStatus`(`present` / `missing` / `not_required`),从不回显密钥值。
- 明文密钥只在发请求的那一刻存在于内存中;不缓存到全局对象、不写入事件、不写入消息。

### 2.1 实现细节(PR #4)

- `secrets.yaml` 只支持扁平映射(`NAME: value`,可加引号与注释),不认识的行直接报错;文件按修改时间缓存。
- 配置档 schema 拒绝未知字段:客户端若把明文放进 `apiKey` 等字段,返回 400,而不是被静默丢弃。

### 3. 脱敏

- 日志:每一行写出前经过脱敏器(pino `hooks.streamWrite`),替换本进程加载过的全部密钥值与常见形态;此外 pino `redact` 覆盖 `*.apiKey`、`*.authorization`、`*.headers.authorization`、`*.password`、`*.token`、`*.cookie`。
- 所有上游错误在抛出前经 `redact()`:把当前进程已加载的全部密钥值、`Bearer <token>`、`sk-…` / `ghp_…` 等常见密钥形态替换为 `[REDACTED]`,并截断上游错误正文(≤500 字)。
- 录制回放 fixture(`packages/eval`)在落盘前同样脱敏,并去掉 `Authorization` 等请求头;CI 中有一道检查,扫描 fixture 目录中是否出现高熵密钥形态。

### 4. 测试

- 回放测试覆盖:OpenAI 风格流(含 usage)、Ollama 风格流(无 usage)、工具调用、上游 401 / 429 / 500、首 token 超时、中途取消。
- 密钥泄露测试:用假密钥跑完整流程,上游 mock 在错误正文中回显该密钥;断言日志、API 响应、事件表、fixture 中都找不到它。

### 5. Anthropic 与 Gemini 原生适配(M1 PR `feat/native-providers`)

- **同样只用 `fetch`,不引入 SDK**:两种协议都是一个 POST 加 SSE,与 OpenAI 兼容适配共用 `src/http.ts`(SSE 解析、收到数据前对连接错误与 429 / 5xx / 529 退避重试一次、错误分类与脱敏、中断与首包超时、连接测试外壳)。零新增运行时依赖,服务器空闲内存不变。
- **Anthropic**(`src/anthropic.ts`):`POST {baseURL}/messages`,默认 `https://api.anthropic.com/v1`;头 `x-api-key` + `anthropic-version: 2023-06-01`。system 消息合并到顶层 `system`;工具结果作为 user 消息中的 `tool_result` 块;相邻同角色消息合并(API 要求交替)。`max_tokens` 必填,配置档没给时用 4096;`temperature` 超过 1 时截断为 1。流式事件按 `content_block_*` 拼接文本与 `input_json_delta`,`stop_reason` 映射为 stop / length / tool-calls,流中的 `error` 事件抛 `upstream_error`。连接测试读 `GET /models`。
- **Gemini**(`src/gemini.ts`):`POST {baseURL}/models/{model}:streamGenerateContent?alt=sse`,默认 `https://generativelanguage.googleapis.com/v1beta`;**密钥放 `x-goog-api-key` 头,不放 URL 查询参数**(URL 可能进入日志)。system → `systemInstruction`,assistant → `model`,工具结果 → user 中的 `functionResponse`(按 callId 找回函数名,结果包成 `{ result }`)。工具参数 schema 转为 Gemini 支持的 OpenAPI 子集:只保留 type / properties / required / items / enum 等键,类型改大写,`["string","null"]` 改为 `nullable`。跳过 `thought` 部分;有函数调用时结束原因为 tool-calls(Gemini 此时仍报 STOP)。无效密钥时 Gemini 返回 400,按正文归为 `auth_failed`。连接测试读 `GET /models`。
- 三种适配器发给模型的工具名都经 `toWireToolName()`(`memory.save` → `memory__save`),收到调用时还原。
- **已知限制**:Gemini 思考模型在函数调用部分附带的 `thoughtSignature` 目前不回传(`ChatMessage` 里没有存放它的位置)。Gemini 2.5 只是建议回传;如果以后的模型强制要求,需要给工具调用加一个不透明的 provider 元数据字段,届时另写 ADR。
- 测试:合成 fixture(`anthropic-*.json`、`gemini-*.json`,`synthetic: true`)按官方流式格式手写,覆盖文本 + 工具调用、请求体格式转换、密钥位置、usage、流中错误、连接测试与无效密钥。业主有对应账号后可用 `AIP_EVAL_LIVE=1` 重录。

## 后果

- 换实现或引入 SDK 只影响 `packages/providers`。
- 用户必须通过环境变量或本地文件配置密钥,Web UI 只能选择引用;这对远程部署不够方便,M5 再补加密存储。

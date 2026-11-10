# M1 实施方案 · 对话核心 + BYO LLM + API v1

> 注:项目已于 2026-11-10 由 AI-Personal 改名为 FatCat-AI(ADR 0019)。本文是当时的记录,文中的包名 `@ai-personal/*`、命令 `ai-personal`、目录 `~/.ai-personal` 与 `AIP_*` 环境变量现在分别是 `@fatcat-ai/*`、`fatcat-ai`、`~/.fatcat-ai` 与 `FATCAT_AI_*`。

- 版本:v1.1 · 2026-11-03 · 状态:**业主已确认(2026-11-03),按第 8 节顺序分 PR 实施**
- 实施中的调整:存储层不用 Drizzle / drizzle-kit,改为手写 SQL 迁移与参数化查询(PR #2、#3,见 ADR 0005);下文中提到 Drizzle 的地方以 ADR 0005 为准;模型网关不用 AI SDK,改为 fetch 自写(PR #4,见 ADR 0006)
- 依据:开发计划第 3 节(技术栈,3.4 / 3.5)、第 6 节(核心接口)、6.1(headless 核心与 v1 API)、第 7 节(安全)、第 8 节 M1;《记忆模块补充设计》第 9 节对 M1 的建议
- 前置:M0 已完成,CI 全绿(`main` @ `f0cbf7b`)

## 0. 范围一览

M1 交付的是一个**不依赖 Web UI 也能完整使用**的对话核心:

1. 模型网关:用户自带 OpenAI 兼容端点(base URL / key / model),流式输出;另有 Anthropic / Gemini 原生适配。
2. 会话与消息存储(SQLite + Drizzle 迁移),流式 SSE,中断 / 重试 / 重新生成,刷新页面后可续看进行中的回复。
3. 上下文窗口管理:超长时用 cheap 配置档压缩旧轮次。
4. 鉴权:主人账户初始化(单用户)、登录、个人访问令牌;未登录访问 API 一律 401。
5. 长期记忆 v1:`memory.save` / `memory.search` 两个工具,以及 UI 查看 / 编辑 / 删除。
6. 客户端:`packages/client`(TS SDK,Apache-2.0)、最小命令行聊天 `apps/cli`、Web UI(会话列表、聊天窗口、设置页、深浅色、中英文骨架)。
7. 6.1 节要求在 M1 就满足:OpenAPI 文档可访问、WebSocket 断线重连补发事件、不开 Web UI 用 CLI / curl 完成一次完整对话(及审批,见第 7 节问题 2)。

**不在 M1**:文件 / 网页等工具与审批框架全量(M2)、知识地图 API(M2)、记忆 v2 的检索融合与维护任务(M2)、语音(M4)、渠道(M5)、TOTP 与设备配对(M5)、对外的 `/v1/chat/completions` 兼容端点(1.x 可选)。

---

## 1. 包与文件清单(按目录)

新增依赖(均已核对许可证,全部为宽松许可):`ai` 7 / `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` / `@ai-sdk/google`(Apache-2.0)、`better-sqlite3`(MIT)、`drizzle-orm`(Apache-2.0)、`drizzle-kit`(MIT,仅开发)、`pino`(MIT)、`@hono/zod-openapi`(MIT)、`ulidx`(MIT)、`citty`(MIT)、`msw`(MIT,仅测试)、`@tanstack/react-router` / `@tanstack/react-query` / `tailwindcss` / `react-markdown` / `i18next`(MIT)。

```
packages/shared/src/                 (Apache-2.0,契约,先写 ADR)
  errors.ts          错误码枚举与 ProblemDetails schema
  pagination.ts      游标分页 Page<T>
  models.ts          ModelProfile、ModelPurpose、连接测试结果
  sessions.ts        Session、Message、MessagePart、发送消息请求
  events.ts          AgentEvent(联合类型)、事件信封 EventEnvelope、assistant-state
  auth.ts            setup / login / token 请求与响应
  memory.ts          memory v1 的输入输出(按补充设计的命名取子集)
  ws.ts              WebSocket 帧 {v, type, id, seq, payload}
  index.ts           统一导出

packages/storage/                    (新包,AGPL-3.0-only;见问题 4)
  src/db.ts          打开连接:foreign_keys=ON、journal_mode=WAL、busy_timeout、synchronous=NORMAL
  src/schema/*.ts    Drizzle 表定义(owners、auth、model_profiles、settings、sessions、messages、runs、events、items、item_edges、memory_facts、memory_sources、session_summaries)
  src/migrate.ts     启动时迁移:先在线备份,再在一个事务内顺序执行
  src/repos/*.ts     sessions / messages / runs / events / profiles / memory 仓储
  migrations/0001_init.sql …          drizzle-kit 生成并提交到仓库的 SQL

packages/providers/                  (AGPL-3.0-only)
  src/types.ts       ModelProvider 接口、ChatRequest、ChatChunk、ProviderError
  src/registry.ts    按配置档创建 provider;按用途(chat / cheap)路由
  src/openai-compatible.ts  基于 @ai-sdk/openai-compatible
  src/anthropic.ts / src/gemini.ts
  src/secrets.ts     apiKeyRef 解析(env: / file:),只在内存中出现明文
  src/redact.ts      错误信息与日志的密钥脱敏
  test/fixtures/*.sse 录制的流式响应

packages/agent/                      (AGPL-3.0-only)
  src/run.ts         单次运行:组装上下文 → 调模型 → 产出 AgentEvent → 持久化 → 广播
  src/context.ts     上下文窗口管理(最近 N 轮原文 + 旧轮摘要)
  src/tools.ts       M1 只有 memory.save / memory.search 的最小工具循环
  src/bus.ts         进程内事件总线(按 owner 订阅,供 SSE / WS 消费)

packages/memory/                     (AGPL-3.0-only)
  src/v1.ts          save / search / list / update / delete(FTS5 检索)
  src/secrets.ts     凭据拒存的最小规则集(sk- / ghp_ / PEM 等,完整版在 M2)

packages/client/                     (Apache-2.0)
  src/index.ts       createClient({ baseUrl, token })
  src/sse.ts         SSE 解析与断线续传(Last-Event-ID)
  src/ws.ts          WebSocket 客户端(lastSeq 补发)

apps/server/src/
  config.ts          增加数据目录、配置文件路径、主密钥等
  log.ts             换成 pino(redact 配置)
  auth/              owner 初始化、登录、cookie 会话、CSRF、PAT、鉴权中间件
  routes/            meta、auth、models、sessions、runs、memory、settings、openapi、ws
  errors.ts          统一错误处理 → problem+json
  index.ts           启动:迁移 → 组装 → 监听

apps/cli/                            (AGPL-3.0-only,新增 package.json)
  src/index.ts       citty 入口,bin 为 ai-personal
  src/commands/{login,chat,ask,sessions,models}.ts

apps/web/src/                        路由、会话列表、聊天窗口、设置页、主题、i18n(只用 packages/client)

packages/eval/                       录制回放适配器(msw 拦截 provider HTTP,`--live` 重录)

docs/adr/
  0004-api-v1-conventions.md    错误格式、分页、SSE、事件序号、鉴权方式
  0005-storage.md               SQLite 连接参数、迁移与备份、id 规则
  0006-model-gateway.md         ModelProvider 接口、密钥来源与脱敏
```

《记忆模块补充设计》建议的 `docs/adr/0004-memory-v2.md` 顺延编号为 `0007-memory-v2.md`,在 PR #1 中与补充设计一并写入(业主已正式采纳补充设计)。

---

## 2. 模型网关

### 2.1 接口(packages/providers)

外面自封一层,AI SDK 只是其中一种实现;以后换实现或 AI SDK 升大版本时,上层不用改。

```ts
export interface ModelProfile {
  // 存在 model_profiles 表,不含明文密钥
  id: string;
  label: string;
  kind: 'openai-compatible' | 'anthropic' | 'gemini';
  baseURL?: string; // openai-compatible 必填,如 http://127.0.0.1:11434/v1
  apiKeyRef: string | null; // 'env:OPENAI_API_KEY' | 'file:openai' | null(如本地 Ollama)
  model: string; // 如 'qwen3:8b'、'gpt-4.1-mini'
  purpose: ('chat' | 'cheap' | 'embed' | 'stt' | 'tts')[];
  contextWindow?: number; // 用于上下文管理,缺省 8192
  params?: { temperature?: number; maxOutputTokens?: number };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[]; // M1 只有 memory.*
  signal: AbortSignal; // 中断
}

export type ChatChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; callId: string; name: string; input: unknown }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool-calls' | 'error' | 'aborted'; usage?: Usage };

export interface ModelProvider {
  readonly profileId: string;
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  test(
    signal: AbortSignal,
  ): Promise<
    { ok: true; latencyMs: number; models?: string[] } | { ok: false; error: ProviderErrorCode; message: string }
  >;
}

export type ProviderErrorCode =
  'auth_failed' | 'not_found' | 'rate_limited' | 'timeout' | 'bad_request' | 'upstream_error' | 'network_error';
```

- **OpenAI 兼容**:`POST {baseURL}/chat/completions`,`stream: true`,需要时带 `stream_options.include_usage`(Ollama 等不返回 usage 时 `usage` 为空,不报错)。连接测试先 `GET {baseURL}/models`,失败再发一次 `max_tokens: 1` 的最小请求。
- **超时与重试**:首 token 超时 60s(可配),整体无上限,但可中断;只对连接错误和 429 / 5xx 做一次退避重试,而且只在还没输出任何 token 时重试。
- **按用途路由**:`registry.forPurpose('chat' | 'cheap')`;没有 cheap 配置档时回退到 chat 配置档。

### 2.2 密钥:只来自环境变量或本地配置,不进日志

- `apiKeyRef` 只有两种:`env:NAME`(读 `process.env[NAME]`)和 `file:NAME`(读数据目录下 `secrets.yaml` 中的 `NAME`,文件权限要求 0600,权限过宽时启动报警)。数据库、API 响应、导出配置里**只出现引用,不出现明文**。
- 对外接口:创建 / 修改配置档时只能填 `apiKeyRef`,不能提交明文密钥(见问题 1);`GET /models` 返回 `apiKeyRef` 和 `keyStatus: 'present' | 'missing'`,不回显值。
- 日志:pino 的 `redact` 覆盖 `*.apiKey`、`*.authorization`、`headers.authorization`、`*.password`、`*.token`;另外所有 provider 错误在抛出前经 `redact.ts`,把已加载的密钥值、`Bearer …`、`sk-…` 形态替换为 `[REDACTED]`。
- 测试:用一个假密钥跑完整流程(含上游返回 401、上游在错误正文里回显 key),捕获全部日志与 API 响应,断言假密钥一次都不出现。

---

## 3. v1 API

### 3.1 通用约定(ADR 0004)

- 前缀 `/api/v1`;除 `GET /api/v1/meta`、`POST /api/v1/auth/setup`(仅在尚未初始化时)、`POST /api/v1/auth/login` 外,**全部需要鉴权**。响应头带 `X-AIP-Server-Version` 和 `X-Request-Id`。
- 鉴权两种:Web 用 HttpOnly + SameSite=Strict 的会话 Cookie,修改类请求还要带 `X-CSRF-Token`(双提交);CLI / 脚本用 `Authorization: Bearer aip_pat_…`(个人访问令牌,库里只存哈希)。
- 分页:游标 `?cursor=&limit=`(limit 默认 50、上限 200),返回 `{ items, nextCursor }`。
- 错误:统一 `application/problem+json`(RFC 9457),额外带机器可读的 `code`。
- OpenAPI:路由用 `@hono/zod-openapi` 定义,`GET /api/v1/openapi.json` 自动生成(本身也需要鉴权?见问题 7)。

### 3.2 端点清单

| 方法与路径                                                                          | 说明                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /meta`                                                                         | 已有;`capabilities` 增加 `chat`、`memory`                                                                              |
| `GET /auth/status`                                                                  | `{ initialized, authenticated }`(公开,便于首次启动引导)                                                                |
| `POST /auth/setup`                                                                  | 首次启动创建主人账户(用户名 + 密码);已初始化后返回 409。仅接受来自 127.0.0.1 的请求,或携带启动日志中打印的一次性设置码 |
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me`                           | 登录(限速:每 IP 5 次/分钟)/ 登出 / 当前用户                                                                            |
| `GET /tokens` · `POST /tokens` · `DELETE /tokens/:id`                               | 个人访问令牌:列表 / 创建(明文只在创建时返回一次)/ 吊销                                                                 |
| `GET /models` · `POST /models` · `GET/PATCH/DELETE /models/:id`                     | 模型配置档 CRUD                                                                                                        |
| `POST /models/:id/test`                                                             | 连接测试                                                                                                               |
| `GET /settings` · `PUT /settings`                                                   | 默认 chat / cheap 配置档、语言、主题、记忆开关等                                                                       |
| `GET /sessions` · `POST /sessions`                                                  | 会话列表(按 updatedAt 倒序,游标)/ 新建                                                                                 |
| `GET/PATCH/DELETE /sessions/:id`                                                    | 详情 / 改标题、换配置档 / 删除(级联删除消息、运行、事件)                                                               |
| `GET /sessions/:id/messages`                                                        | 消息列表(游标,按 seq)                                                                                                  |
| `POST /sessions/:id/messages`                                                       | 发送用户消息并启动一次运行,**响应为 SSE** 推送 AgentEvent;加 `?stream=false` 时立即返回 `202 { runId, userMessageId }` |
| `POST /sessions/:id/messages/:messageId/regenerate`                                 | 重新生成某条助手回复(旧回复保留为分支,`parentMessageId` 关联)                                                          |
| `GET /runs/:runId`                                                                  | 运行状态                                                                                                               |
| `GET /runs/:runId/events`                                                           | **续看**:SSE,先补发 `Last-Event-ID`(或 `?after=seq`)之后的事件,运行未结束时继续推送                                    |
| `POST /runs/:runId/cancel`                                                          | 中断                                                                                                                   |
| `POST /runs/:runId/retry`                                                           | 对失败的运行用相同输入重试                                                                                             |
| `POST /approvals/:callId`                                                           | `{ decision: 'approve'                                                                                                 | 'reject' }`(见问题 2) |
| `GET /memory` · `POST /memory` · `PATCH/DELETE /memory/:id` · `POST /memory/search` | 记忆 v1                                                                                                                |
| `GET /ws`                                                                           | WebSocket,握手协商 `protocolVersion`,支持 `lastSeq` 补发                                                               |
| `GET /openapi.json`                                                                 | OpenAPI 3.1                                                                                                            |

运行与 HTTP 连接**解耦**:客户端断开不会中断运行(只有 `cancel` 会),事件持续写入 `events` 表,所以刷新页面后用 `GET /runs/:runId/events` 就能续看。

### 3.3 zod schema(packages/shared,草图)

```ts
// errors.ts
export const ErrorCode = z.enum([
  'unauthorized',
  'forbidden',
  'csrf_failed',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'not_initialized',
  'model_profile_missing',
  'model_key_missing',
  'provider_error',
  'run_not_active',
  'internal',
]);
export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  requestId: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
  providerCode: z.string().optional(), // 上游错误归类,已脱敏
});

// pagination.ts
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// models.ts
export const ModelPurpose = z.enum(['chat', 'cheap', 'embed', 'stt', 'tts']);
export const ApiKeyRef = z
  .string()
  .regex(/^(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .nullable();
export const ModelProfileInput = z
  .object({
    label: z.string().min(1).max(60),
    kind: z.enum(['openai-compatible', 'anthropic', 'gemini']),
    baseURL: z.url().optional(),
    apiKeyRef: ApiKeyRef,
    model: z.string().min(1).max(200),
    purpose: z.array(ModelPurpose).min(1),
    contextWindow: z.number().int().min(1024).max(2_000_000).optional(),
    params: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .refine((p) => p.kind !== 'openai-compatible' || p.baseURL, { message: 'baseURL is required', path: ['baseURL'] });
export const ModelProfile = ModelProfileInput.extend({
  id: z.string(),
  keyStatus: z.enum(['present', 'missing', 'not_required']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

// sessions.ts
export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), callId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool-result'), callId: z.string(), output: z.unknown(), error: z.string().optional() }),
]);
export const Message = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePart),
  status: z.enum(['streaming', 'complete', 'error', 'cancelled']),
  runId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  modelProfileId: z.string().nullable(),
  usage: Usage.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const Session = z.object({
  id: z.string(),
  title: z.string(),
  modelProfileId: z.string().nullable(),
  lastMessageAt: z.iso.datetime().nullable(),
  activeRunId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const SendMessageRequest = z.object({
  text: z.string().min(1).max(100_000),
  modelProfileId: z.string().optional(), // 覆盖会话默认
  clientMessageId: z.string().max(64).optional(), // 幂等:重复提交返回同一 runId
});

// events.ts(在计划第 6 节 AgentEvent 基础上补齐 M1 需要的类型)
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run-started'),
    runId: z.string(),
    sessionId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
  }),
  z.object({ type: z.literal('text-delta'), runId: z.string(), delta: z.string() }),
  z.object({
    type: z.literal('tool-call'),
    runId: z.string(),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ type: z.literal('approval-required'), runId: z.string(), callId: z.string(), summary: z.string() }),
  z.object({
    type: z.literal('tool-result'),
    runId: z.string(),
    callId: z.string(),
    output: z.unknown(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('run-finished'),
    runId: z.string(),
    reason: z.enum(['stop', 'length', 'cancelled']),
    usage: Usage.optional(),
  }),
  z.object({ type: z.literal('run-failed'), runId: z.string(), error: ProblemDetails }),
  z.object({
    type: z.literal('assistant-state'),
    state: z.enum(['idle', 'listening', 'thinking', 'speaking', 'executing']),
    label: z.string().optional(),
    toolName: z.string().optional(),
    level: z.number().min(0).max(1).optional(),
  }),
]);
export const EventEnvelope = z.object({
  seq: z.number().int(),
  at: z.iso.datetime(),
  sessionId: z.string().nullable(),
  event: AgentEvent,
});
```

SSE 帧:`id: <seq>`、`event: agent`、`data: <EventEnvelope JSON>`;每 15 秒一行 `: ping` 心跳,避免反向代理断开。`seq` 是全局单调递增的事件序号,WebSocket 帧的 `seq` 用同一个,两条通道可以互相补发。

---

## 4. SQLite 存储层

### 4.1 连接与迁移(ADR 0005)

- `better-sqlite3`(同步 API,单进程单写连接,足够个人规模)。每个连接打开后依次执行:`PRAGMA foreign_keys = ON`、`journal_mode = WAL`、`busy_timeout = 5000`、`synchronous = NORMAL`,并**立即读回 `PRAGMA foreign_keys` 断言为 1**,否则拒绝启动。
- 数据库位置:`$AIP_DATA_DIR/db.sqlite`(默认 `~/.ai-personal/`,Docker 中为 `/data`)。
- 迁移:`drizzle-kit generate` 生成 SQL,文件提交到 `packages/storage/migrations/`,**不在运行时生成**。启动时:① 如有待执行的迁移,先用 `db.backup()` 在线备份到 `backups/db-<时间>-pre-<版本>.sqlite`(保留最近 5 份);② 在一个事务中按顺序执行;③ 写入 `__drizzle_migrations`。任何一步失败,启动中止并提示从备份恢复。
- 需要给已有表加带外键的列时(SQLite 的 `ALTER TABLE ADD COLUMN` 对外键列有限制),按「建新表 → 拷数据 → 删旧表 → 改名」的标准做法,在迁移中临时 `PRAGMA foreign_keys = OFF`,迁移后执行 `PRAGMA foreign_key_check`,不通过就回滚。
- id 用 ULID(按时间有序,便于游标分页);时间统一存 ISO-8601 UTC 文本。所有业务表带 `owner_id`(1.0 恒为主人 id)。

### 4.2 M1 的表

| 表                  | 主要列                                                                                                                                                | 外键 / 约束                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `owners`            | id, username, password_hash(scrypt), created_at                                                                                                       | 1.0 只允许 1 行                                                                                                 |
| `auth_sessions`     | id(随机 256 位,存哈希), owner_id, csrf_token_hash, expires_at, last_seen_at                                                                           | owner_id → owners ON DELETE CASCADE                                                                             |
| `access_tokens`     | id, owner_id, name, token_hash, last_used_at, expires_at, revoked_at                                                                                  | 同上                                                                                                            |
| `model_profiles`    | id, owner_id, label, kind, base_url, api_key_ref, model, purpose_json, context_window, params_json                                                    | —                                                                                                               |
| `settings`          | owner_id, key, value_json                                                                                                                             | PK(owner_id, key)                                                                                               |
| `sessions`          | id, owner_id, title, model_profile_id, last_message_at, created_at, updated_at                                                                        | model_profile_id → model_profiles ON DELETE SET NULL                                                            |
| `messages`          | id, session_id, owner_id, seq, role, parts_json, status, run_id, parent_message_id, model_profile_id, usage_json                                      | session_id → sessions ON DELETE CASCADE;parent_message_id → messages ON DELETE SET NULL;UNIQUE(session_id, seq) |
| `runs`              | id, session_id, owner_id, status(queued/running/succeeded/failed/cancelled), input_message_id, output_message_id, error_json, started_at, finished_at | session_id → sessions ON DELETE CASCADE                                                                         |
| `events`            | seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id, session_id, run_id, type, payload_json, created_at                                                   | run_id → runs ON DELETE CASCADE;索引 (owner_id, seq)、(run_id, seq)                                             |
| `session_summaries` | id, session_id, from_seq, to_seq, summary                                                                                                             | session_id → sessions ON DELETE CASCADE(与补充设计一致)                                                         |
| 记忆 v1             | 见问题 3                                                                                                                                              |                                                                                                                 |

文本增量事件很多,为了不撑大库:运行结束后把该运行的 `text-delta` 事件合并成一条(助手消息正文已经完整写进 `messages`),只保留结构性事件,补发窗口内(默认 24 小时)不做合并。

### 4.3 测试计划

- **单测**:每个连接 `PRAGMA foreign_keys` = 1;删除会话后,消息、运行、事件、摘要全部被级联删除;删除配置档后会话的 `model_profile_id` 置空;`messages.seq` 唯一且连续;游标分页在并发插入时稳定(不重、不漏)。
- **迁移测试**:空库迁移到最新;构造上一版本的库(fixture)再迁移,数据不丢,`foreign_key_check` 为空;迁移失败时回滚,并且备份文件存在。
- **集成**:临时目录里的真实 SQLite 文件,对 server 发 HTTP 请求跑完整对话;运行中途杀掉 SSE 连接,再用 `GET /runs/:id/events` 续看,拼出的正文与库里的消息一致。
- **性能**:1 万条消息的会话,`GET /sessions/:id/messages` P95 < 20ms。

---

## 5. 最小命令行聊天(apps/cli)

bin 名为 `ai-personal`,只通过 `packages/client` 调用公开 API。

```bash
# 登录:用账号密码换一个个人访问令牌,保存在 ~/.ai-personal/cli.json(权限 0600)
ai-personal login --server http://127.0.0.1:8787

# 交互式聊天:新建会话,流式输出;Ctrl+C 中断当前回复,再按一次退出
ai-personal chat
ai-personal chat --session 01JC… --model ollama-qwen

# 单次提问,适合脚本;--json 输出 EventEnvelope 行
ai-personal ask "用三句话解释 AGPL 第 13 条"
echo "总结这段话" | ai-personal ask --stdin --json

# 会话与配置档
ai-personal sessions list
ai-personal sessions show 01JC…        # 打印历史消息
ai-personal models list
ai-personal models test ollama-qwen
```

- 配置优先级:命令行参数 > 环境变量 `AIP_SERVER` / `AIP_TOKEN` > `~/.ai-personal/cli.json`。
- 交互模式中的命令:`/new` 新会话、`/model <id>` 切换配置档、`/retry` 重新生成、`/exit`。
- 断线时自动用 `Last-Event-ID` 续看;stderr 输出状态(思考中、已中断),stdout 只输出正文,便于管道。
- 核心本身的启动命令是 `ai-personal-server`(`apps/server` 的 bin),对应计划中的 `ai-personal serve`。我打算让 CLI 提供 `ai-personal serve` 子命令转发启动 server,实现上只是调用 server 包的入口。

---

## 6. 验收标准对照

| 计划中的验收项                                                             | 如何满足                                             | 如何验证                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 填入任意 OpenAI 兼容端点(含 Ollama)即可流式对话                            | `openai-compatible` provider;`apiKeyRef` 可为空      | 录制回放测试覆盖 OpenAI 和 Ollama 两种流格式(含无 usage 的情况);再用真实 Ollama 手工验收一次(见问题 8) |
| 刷新页面可续看进行中的回复                                                 | 运行与连接解耦 + 事件持久化 + `GET /runs/:id/events` | 集成测试:中途断开 SSE 后续看;Web 端用 Playwright 在流式中刷新页面                                      |
| 未登录访问 API 返回 401                                                    | 全局鉴权中间件,白名单只有 3 个端点                   | 测试遍历 OpenAPI 中的全部路由,无凭据请求都必须是 401                                                   |
| 单测覆盖 providers 与会话存储                                              | 第 2、4 节的测试                                     | `packages/providers`、`packages/storage` 覆盖率 ≥ 80%(计划第 11 节门禁)                                |
| 录制回放测试通过                                                           | `packages/eval` 回放适配器,CI 中只跑回放             | CI;`pnpm eval --live` 可重录                                                                           |
| 6.1:不开 Web UI 也能用 CLI / curl 完成对话(与审批)                         | CLI + 文档化的 curl 示例                             | 端到端脚本:起 server → setup → 建配置档(指向 mock 端点)→ `ai-personal ask`                             |
| 6.1:OpenAPI 可访问                                                         | `/api/v1/openapi.json`                               | 测试用 OpenAPI 校验器校验生成结果;CI 存档,为以后的 oasdiff 破坏性变更检测做基线                        |
| 6.1:WebSocket 断线重连补发事件                                             | `lastSeq` 补发                                       | 集成测试:WS 连接 → 运行中断开 → 带 lastSeq 重连 → 事件不重不漏                                         |
| 记忆 v1:模型可调用 `memory.save` / `memory.search`;UI 可查看 / 编辑 / 删除 | 第 1 节 memory 包 + 工具 + REST                      | 回放测试:「记住我住杭州」→ 新会话「我住哪」命中;含 `sk-…` 的内容被拒存                                 |
| 镜像资源预算                                                               | 不新增常驻服务                                       | CI docker 任务:空闲 RSS 继续 < 120MB(M0 门禁),另加一次对话峰值测量                                     |

---

## 7. 风险点

1. **AI SDK 7 迭代快**:只在 `packages/providers` 内部使用,对外是我们自己的接口;依赖用 `~` 锁小版本,升级靠回放测试兜底。
2. **better-sqlite3 是原生模块**:Docker(amd64 / arm64)和 Windows 依赖预编译包,`pnpm` 需把它加入 `onlyBuiltDependencies`;CI 增加 arm64 构建前要先确认预编译可用。备选是 Node 内置的 `node:sqlite`(还未稳定)。
3. **SSE 经过反向代理被缓冲或断开**:加心跳和 `X-Accel-Buffering: no`;续看机制兜底。
4. **各家 OpenAI 兼容端点有差异**(usage、工具调用格式、错误体):用录制回放覆盖常见几家;遇到不兼容按 `kind` 加小的适配开关,不分叉代码。
5. **密钥泄露**:上游错误正文里可能回显 key;所有错误统一经脱敏,并有专门测试。
6. **事件表膨胀**:文本增量事件合并策略(第 4.2 节);2GB 机器上观察库大小。
7. **上下文压缩质量与成本**:cheap 模型摘要可能丢信息;原文永远保留在 `messages`,压缩只影响送给模型的内容;每会话摘要调用设上限。
8. **范围膨胀**:Web UI 只做计划列出的页面;Anthropic / Gemini 适配放在最后一个 PR,时间不够可以挪到 M1.x(需你同意)。

---

## 8. 工作拆分(每个 PR 一个 feat/ 分支)

| #   | 分支                    | 内容                                                                      | 验收                          |
| --- | ----------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| 1   | `docs/m1-contracts`     | ADR 0004–0007;补充设计并入主计划;`packages/shared` 新增 schema 与单测     | schema 单测;你审阅 ADR        |
| 2   | `feat/storage`          | `packages/storage`:连接、迁移、备份、仓储                                 | 第 4.3 节单测与迁移测试       |
| 3   | `feat/auth`             | 主人初始化、登录、Cookie + CSRF、PAT、鉴权中间件、pino                    | 401 遍历测试;限速;日志无密码  |
| 4   | `feat/providers`        | 模型网关 + 录制回放 + 密钥脱敏 + 配置档 CRUD / 测试                       | 回放测试;假密钥泄露测试       |
| 5   | `feat/chat-runs`        | 会话 / 消息 / 运行、SSE、续看、中断 / 重试 / 重新生成、WebSocket、OpenAPI | 断线续看与 WS 补发集成测试    |
| 6   | `feat/context-memory`   | 上下文管理与摘要压缩;记忆 v1 工具与 REST                                  | 长会话测试;记忆回放用例       |
| 7   | `feat/client-cli`       | `packages/client`、`apps/cli`                                             | 端到端脚本(不开 Web UI)       |
| 8   | `feat/web-chat`         | Web UI:登录、会话列表、聊天、设置、主题、i18n                             | Playwright 冒烟(含流式中刷新) |
| 9   | `feat/native-providers` | Anthropic / Gemini 原生适配                                               | 回放测试                      |
| 10  | `docs/m1-wrapup`        | README 快速开始、CHANGELOG、M1 自检报告                                   | 逐条对照第 6 节               |

是否开 PR 并请你审阅,还是像 M0 一样直接推到 `main`,见问题 9。

---

## 9. 业主决定(2026-11-03)

| #   | 问题               | 决定                                                                                                                                                                                                      |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 明文密钥           | 配置档只能填 `env:` / `file:` 引用,API 与 Web UI 都不接收明文 key;服务器端加密存储推迟到 M5                                                                                                               |
| 2   | 审批流             | M1 做最小审批管道,`memory.save` 默认需要审批;M2 再决定预授权                                                                                                                                              |
| 3   | 记忆 v1 表结构     | M1 提前建 `items` / `item_edges`(只建表)和 `memory_facts` 子集;《记忆模块补充设计》正式采纳并并入主计划,其余部分留到 M2                                                                                   |
| 4   | 存储包             | 新增 `packages/storage`,同步更新计划第 5 节与 AGENTS.md                                                                                                                                                   |
| 5   | TOTP               | 推迟到 M5                                                                                                                                                                                                 |
| 6   | Anthropic / Gemini | 放最后一个 PR,进度紧可移到 M1.x                                                                                                                                                                           |
| 7   | openapi.json       | 需要鉴权;CI 另导出静态文件                                                                                                                                                                                |
| 8   | 手工验收端点       | DeepSeek:`https://api.deepseek.com/v1`,模型 `deepseek-chat`,密钥 `env:DEEPSEEK_API_KEY`;2026-11-03 已录制真实 fixture(`packages/providers/test/fixtures/deepseek-*.json`),录制时 key 不写入任何文件或日志 |
| 8a  | 已确认可用的端点   | DeepSeek(`https://api.deepseek.com/v1`,已录制 fixture)、OpenRouter(`https://openrouter.ai/api/v1`,业主 2026-11-03 确认可用);均按 `openai-compatible` 配置,密钥用 `env:` / `file:` 引用                    |
| 9   | 提交流程           | 每个 PR 一个 `feat/` 或 `docs/` 分支,业主审阅后合并,按第 8 节顺序                                                                                                                                         |

<details><summary>原问题(存档)</summary>

1. **API 能否提交明文密钥?** 你要求密钥只来自环境变量或本地配置,我理解为:M1 中配置档只能填 `env:` / `file:` 引用,Web UI 也不能输入 key。计划第 4 节提到的「服务器端加密存储(主密钥来自环境变量)」推迟到 M5 远程部署时再做。**建议:同意。**
2. **审批流放在 M1 还是 M2?** 6.1 节要求 M1 就能「完成一次完整对话与审批」,但工具与审批框架在 M2。**建议:** M1 做最小审批管道(`approval-required` 事件 + `POST /approvals/:callId`),让 `memory.save` 默认需要审批,用它满足 6.1 的验收;完整的风险分级和审计放 M2。这与补充设计里「memory.write 默认预授权」相反,M2 时再按你的决定调整。
3. **记忆 v1 用什么表结构?** 补充设计第 9 节建议 M1 直接建 `memory_facts` 的子集;它依赖 `items` 表(计划 6.2,原定 M2)。**建议:** M1 提前建 `items` / `item_edges`(只建表,不做知识地图 API)和 `memory_facts` 子集,M2 只做增量迁移。另外请确认补充设计是否已正式采纳;目前它是「草案」,我只按它的数据模型做 M1 的最小子集,不提前实现 v2 的其他部分。
4. **新增 `packages/storage`?** 计划第 5 节没有存储包,但 server、memory、items 都要用同一个数据库连接与迁移。**建议:新增**,并同步更新计划第 5 节与 AGENTS.md。
5. **TOTP 二步验证**:计划第 7 节列在鉴权里。**建议:** 推迟到 M5(对外部署时才真正需要),M1 先做密码 + 令牌。
6. **Anthropic / Gemini 原生适配**:计划 M1 包含。**建议:** 保留在 M1 的最后一个 PR,如果进度紧就移到 M1.x。
7. **`/api/v1/openapi.json` 是否公开?** 公开便于第三方客户端开发,但会暴露接口面。**建议:需要鉴权**(与「全部 API 需要鉴权」一致),CI 另外导出一份静态文件。
8. **手工验收用的真实端点**:录制回放的 fixture 需要先对真实端点录一次。你本机有 Ollama,还是用某个 OpenAI 兼容服务?需要的话请把 key 放在环境变量里,我不会写进任何文件或日志。
9. **提交流程**:M1 每步开 PR 让你审阅后合并,还是继续直接推 `main`?**建议:开 PR**(计划第 13 节的约定),CLA 检查对你自己的提交是豁免的。

</details>

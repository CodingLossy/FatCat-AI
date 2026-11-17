# ADR 0030 · `/api/v1` 与 WebSocket 协议 v1 冻结清单

- 状态:提议(M5c PR 2 `ci/openapi-and-scan`;冻结日期与哈希在发布前由业主确认后补写)
- 日期:2026-11-16
- 相关:AGENTS.md 第 6 条、ADR 0004(API 约定)、ADR 0010 第 10 节(oasdiff)、M5c 方案 PR 2
- 依据:开发计划 M5c「冻结前复核 oasdiff 覆盖全部 `/api/v1`」。

## 背景

AGENTS.md 第 6 条规定 `/api/v1` 与 WebSocket 协议 v1 发布后只做向后兼容的增量修改。冻结要有可核对的范围和机器检查,而不是一句承诺。

## 决定

### 1. 冻结范围

- HTTP:`apps/server/openapi/v1.json`(OpenAPI 3.1,当前 89 个路径、115 个操作)。冻结的是路径、方法、参数、请求与响应结构、状态码和错误格式(RFC 9457,ADR 0004)。
- WebSocket:协议版本 `PROTOCOL_VERSION = 1`(`packages/shared/src/meta.ts`)与 `packages/shared/src/ws.ts` 的帧结构、`events.ts` 的 `AgentEvent` 联合类型。
- **冻结日期与文档哈希**:发布日(版本号改为 1.0.0 之后)由业主确认,再在本节补写。文档里的 `info.version` 随 `SERVER_VERSION` 变化,所以哈希必须在版本号提交之后记录。当前(0.0.0)的文件 SHA-256:`104e81d0ca1468aaf211c16d878e6f84aa17812e79cef64f97d9d33e7edf3701`,仅作参照。

### 2. 冻结后允许的变更

- 新增接口、新增可选请求字段、新增响应字段、新增错误码、新增事件类型与帧类型。
- 响应枚举新增值与事件联合类型新增变体不算破坏性变更,依据 ADR 0004「客户端忽略未知事件类型 / 未知枚举值」。`.github/oasdiff-severity.txt` 把 `response-property-one-of-added`、`response-body-one-of-added` 降为 info,`response-property-enum-value-added` 降为 warn,与此一致;客户端(`packages/client`、Web)必须按此实现。
- 不允许:删除或改名路径与字段、收紧已有字段的类型或取值、把可选字段改成必填、改变状态码含义、改变鉴权要求。这类修改只能走 `/api/v2` 并写新的 ADR。

### 3. 机器检查

1. `apps/server/src/openapi-coverage.test.ts`:路由表里 `/api/v1` 下每个「方法 + 路径」都在 OpenAPI 文档里,文档里每个操作也有路由;有意排除的只有 `GET /api/v1/openapi.json`(文档自身,写在测试的白名单里并写明原因,过期条目会让测试失败)。新增接口忘了进文档会直接失败。
2. CI `OpenAPI breaking changes`(`oasdiff breaking --fail-on ERR`,基线为 PR 的 base 分支):文档只在 PR 上比较;基线没有文档时(只会出现在最初引入文档的 PR)输出警告而不是静默通过。
3. `scripts/check-openapi-breaking.test.mjs`:自测 oasdiff 这一步真的会拦截破坏性变更(删除响应必填字段、删除操作都必须失败,新增接口必须通过)。
4. CI `openapi:export` 之后 `git diff --exit-code`:提交的文档必须与代码一致。
5. `.github/oasdiff-err-ignore.txt` 必须没有条目。每个例外都要业主逐条批准、写明方法路径与原因,所在 PR 合并后清空;CI 对非空文件给出警告。
6. WebSocket:`packages/shared` 的 `contracts.test.ts`(WebSocket 帧、`AgentEvent`)、`meta.test.ts`(`protocolVersion`)与 `apps/server/src/ws.test.ts` 是协议 v1 的契约测试;冻结后它们只增不改,改动已有断言等同于破坏性变更。

### 4. 未覆盖的部分(如实记录)

- oasdiff 只看 OpenAPI 文档;SSE / WebSocket 的事件内容不在文档里,靠第 6 项的契约测试。
- `/healthz` 不在 `/api/v1` 下,不受冻结约束。

## 后果

- 冻结后任何接口改动都会在 PR 上被两道检查(覆盖测试、oasdiff)拦截或显式标出;例外只能由业主批准。
- 发布前需业主确认冻结日期与哈希,再补写第 1 节。

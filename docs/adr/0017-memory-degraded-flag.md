# ADR 0017 · `memory-used` 降级标记:召回少了哪一路要让客户端知道

- 状态:已采纳(开发计划 M5a 开头,先于实现;业主 2026-11-10 决定);实现见 M5a PR 2 `feat/memory-degraded`
- 日期:2026-11-10
- 相关:开发计划第 8 节 M5a;ADR 0004(API v1 约定,客户端忽略未知字段与事件)、ADR 0007 第 5.4、5.6 节(`memory-used` 事件、三路召回)、ADR 0014(嵌入与向量索引)
- 修订:ADR 0007 第 5.4 节的 `memory-used { runId, ids }` 增加两个可选字段(见第 2 节)

## 背景

#42 给记忆召回的向量这一路加了时限(`vectorTimeoutMs`,默认 400 ms):超时或嵌入接口出错时跳过这一路,只用全文与图。FTS 与图是本地同步查询,所以总耗时由这一路的时限决定,不另设 600 ms 的总时限。

跳过之后,这一轮照常回答,但客户端看不出召回是不完整的:「本次用到的记忆」面板为空,可能是真没有相关记忆,也可能是向量这一路没跑完。M5a 接入 IM 渠道后,嵌入端点更容易因网络慢而超时,这个区别更重要。另外,检索结果里已有的 `omitted`(因 token 预算没有展示的条数)只出现在 `POST /memory/retrieve` 与 `memory.search` 的返回中,事件里没有。

## 1. 决定

1. `memory-used` 事件增加两个**可选**字段 `degraded` 与 `omitted`;`MemoryRetrieveResult` 增加同样的可选字段 `degraded`。
2. 只有「本来该跑、却没跑完」才算降级;没有配置 embed 配置档、向量索引维度不匹配这类**配置状态**不算(它们已在「设置 → 向量索引」中显示,每轮都提示只会是噪音)。
3. 有降级时,即使这一轮没有用到任何记忆也发送 `memory-used`(`ids` 为空数组),让客户端能说明「记忆可能不完整」。没有降级且没有用到记忆时,和现在一样不发送。
4. 降级只是旁路信息,不改变召回、排序、预算、渠道过滤或审批的任何判断。

## 2. 契约(`packages/shared`)

```ts
/** 召回中没有跑完的一路(ADR 0017)。 */
export const MemoryDegradation = z.object({
    /** 召回路径;目前只有 vector 会降级,fts 与 graph 先占位。 */
    path: z.enum(['fts', 'vector', 'graph']),
    /**
     * timeout:超过时限被中止;auth:嵌入接口返回 401 / 403(密钥多半失效);
     * rejected:嵌入接口返回其他不可重试的 4xx;error:其余出错(5xx、429、网络、本地查询)。
     */
    reason: z.enum(['timeout', 'auth', 'rejected', 'error']),
});

// AgentEvent 中:
z.object({
    type: z.literal('memory-used'),
    runId: Id,
    ids: z.array(Id),
    /** 自 M5a 起提供;没有降级时省略。 */
    degraded: z.array(MemoryDegradation).max(3).optional(),
    /** 自 M5a 起提供:因预算没有展示给模型的相关记忆条数;为 0 时省略。 */
    omitted: z.number().int().positive().optional(),
});

// MemoryRetrieveResult 增加:
degraded: z.array(MemoryDegradation).max(3).optional(),
```

- **向后兼容**(ADR 0004):都是响应中新增的可选字段。旧客户端用 `z.object` 解析时会丢掉未知字段;旧服务器不发送,客户端把「没有字段」当作「没有降级 / 不知道」。
- **枚举以后扩展**:`path` 与 `reason` 以后可能加值(例如 `reason: 'skipped'`),客户端遇到不认识的值时按「有降级、原因未知」显示,不报错。`fts` 与 `graph` 现在就写进枚举,避免以后再加值。
- `omitted` 的含义与 `MemoryRetrieveResult.omitted` 相同,只取每轮检索那一次的值;digest 不计入。

## 3. 何时算降级

| 情况                                                         | 是否降级                                 |
| ------------------------------------------------------------ | ---------------------------------------- |
| 没有 embed 配置档 / 从未建过向量索引(`VectorSearch` 不存在)  | 否                                       |
| 向量索引维度与配置档不符,`VectorSearch` 返回 `null`          | 否(配置状态,设置页已提示)                |
| 超过 `vectorTimeoutMs` 被中止                                | `{ path: 'vector', reason: 'timeout' }`  |
| 嵌入接口返回 401 / 403(`ProviderError.code = 'auth_failed'`) | `{ path: 'vector', reason: 'auth' }`     |
| 嵌入接口返回其他 4xx(`bad_request`、`not_found`)             | `{ path: 'vector', reason: 'rejected' }` |
| 嵌入接口返回 408                                             | `{ path: 'vector', reason: 'timeout' }`  |
| 429、5xx、网络错误、本地向量查询抛错                         | `{ path: 'vector', reason: 'error' }`    |
| 本轮用户消息为空、记忆功能关闭                               | 否(本来就不检索)                         |

按 `packages/providers` 已有的 `ProviderError.code` 归类(`classifyStatus`),不另解析响应。429 虽是 4xx,但等一会儿就能恢复,所以归 `error`,不归 `rejected`。`auth` 与 `rejected` 是用户要去设置里处理的问题,不会自己好。

实现上,`searchWithin`(`packages/memory/src/retrieve.ts`)从「返回 id 列表」改为「返回 id 列表 + 可选的降级原因」;`retrieve` 汇总后放进结果;`RunManager.memoryFor` 把它和 `omitted` 一起带进事件。

实现补充(M5a PR 2):`packages/memory` 不依赖 `packages/providers`,所以按错误对象上的 `code` / `status` 字段归类(`classifyVectorError`),与 `ProviderError` 的字段一致。向量查询被时限中止后抛出的错误也按 `timeout` 算。日志由检索器的 `onDegraded` 回调写出,`runId` 经 `memoryContext` 的输入传入。

## 4. 日志

降级时写一行本地日志(info 级):`memory.retrieve.degraded`,字段 `path`、`reason`、`elapsedMs`、`runId`,嵌入接口出错时另加 `httpStatus`(只有状态码)。不写查询文本、记忆内容或嵌入接口的响应原文 / 错误文本(可能带端点地址或密钥片段)。只写本地,不外传(开发计划第 10 节零遥测)。

## 5. 客户端

- **Web**:「本次用到的记忆」面板在有 `degraded` 时加一行灰字:「向量检索超时,本轮只用了全文与关联检索,相关记忆可能不全」(`error` 时为「出错」);`auth` 时改为「嵌入密钥可能失效,请检查设置 → 模型配置档」,`rejected` 时为「嵌入接口拒绝了请求,请检查嵌入配置档」,并链接到设置页;有 `omitted` 时显示「另有 N 条相关记忆未展示」。中英文都要有。
- **IM 渠道(M5a)**:默认**不在回复里追加提示**:每条回复都带一句说明很吵,用户在手机上也没法处理;主人在 Web 的会话中仍能看到。M5a 渠道框架补一个开关(默认关):打开后,只在**连续降级或一段时间内降级次数超过阈值**时向主人发**一次**提醒,不逐条提示;提醒之后要等恢复正常再触发下一次。`auth` / `rejected` 也走这个开关,但提醒文案直接说明要去换密钥或检查配置。阈值与时间窗口的具体数字在 M5a 定。
- **CLI / SDK**:`packages/client` 的类型随 `shared` 更新,无需其他改动。

## 6. 测试(实现 PR)

- `packages/shared`:`memory-used` 带 / 不带新字段都能解析;`path` / `reason` 的合法值。
- `packages/memory`:向量这一路超时、抛错时结果带对应的 `degraded`;401 / 403 → `auth`,400 / 404 → `rejected`,429 / 5xx → `error`,408 → `timeout`;返回 `null` 或没有 `VectorSearch` 时不带;FTS 与图的结果不受影响。
- `packages/agent`:有降级且 `ids` 为空时仍发出 `memory-used`;无降级且无记忆时不发;`omitted > 0` 时带上。
- `apps/web`:面板在有 `degraded` / `omitted` 时显示对应文案。
- OpenAPI:`/memory/retrieve` 响应新增可选字段,`openapi-compat` 应为非破坏性变更。

## 7. 后果

- 客户端能区分「没有相关记忆」与「召回不完整」,IM 渠道以后可以据此决定是否提示。
- 契约多两个可选字段,旧客户端不受影响。
- 不增加泄露面:事件和日志里只有路径、原因、条数与耗时。

## 8. 业主决定(2026-11-10)

1. IM 回复默认不提示降级;M5a 只补一个默认关闭的开关,打开后按连续降级或次数阈值提醒一次(第 5 节)。
2. 嵌入接口的 4xx 单独归类:401 / 403 为 `auth`,其他不可重试的 4xx 为 `rejected`;日志只记状态码,不记响应原文(第 2–4 节)。

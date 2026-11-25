# ADR 0050 · 渠道中枢与插件服务下沉(M13 后段 1)

- 状态:提议(按 `docs/milestones/M13-plan.md`「后段顺序」第 1 项)
- 日期:2026-11-25
- 相关:ADR 0004(错误格式 problem+json)、ADR 0022(渠道运行器)、ADR 0040(插件与市场)、ADR 0048(Skills)
- 范围:只搬代码、改依赖方向,不改任何行为、接口、数据库或设置。实现分两个 PR(第 5 节)。
- 语言:中文;代码标识符、包名和文件名保留英文。

## 0. 背景

`apps/server` 按约定只做装配和路由(AGENTS.md「headless 核心」),但两块业务逻辑一直留在里面:

| 模块     | 文件                                                                            | 行数    | 依赖 `apps/server` 内部的东西                                                                   |
| -------- | ------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| 渠道中枢 | `src/channels/hub.ts`、`src/channels/wechat.ts`                                 | 约 1200 | `ApiError`、pino `Logger`、`resolveProfile`(会话路由)、`removeOwnerSessions`、`AttachmentFiles` |
| 插件服务 | `src/plugin-setup.ts`、`plugin-market.ts`、`plugin-items.ts`、`plugin-files.ts` | 约 1900 | `ApiError` / `notFound`、`SERVER_VERSION`                                                       |

后果:渠道框架(`@fatcat-ai/channels`)只有适配器,真正的入站流程(去重、过滤、限流、审批短码、排队)和适配器分在两处;QQ 渠道(后段第 3 项)要接进来只能继续往 `apps/server` 里加。插件服务同理,桌面端和以后的 CLI 想复用插件管理也只能经过 HTTP。

## 1. 错误:`ServiceError` 放进 `packages/shared`

两块代码抛的都是带状态码和稳定错误码的业务错误。把它从 `apps/server/src/errors.ts` 拆出一个不依赖 Hono 的基类:

```ts
// packages/shared/src/errors.ts(Apache-2.0)
export class ServiceError extends Error {
    constructor(
        readonly status: number,
        readonly code: ErrorCode,
        readonly title: string,
        readonly detail?: string,
        readonly extra: ServiceErrorExtra = {},
    ) { ... }
}
export const notFoundError = (what = 'Resource') => new ServiceError(404, 'not_found', 'Not Found', `${what} was not found.`);
```

- `apps/server` 的 `ApiError` 改成 `extends ServiceError`,构造参数不变,现有代码一行不用改;统一错误处理改成 `err instanceof ServiceError`。
- 包里的代码只用 `ServiceError`,不认识 Hono。
- `ErrorCode` 本来就在 shared,错误码集合不变;OpenAPI 不变。

放在 shared 的理由:它是 problem+json 协议的一部分(状态码 + 错误码 + 标题),和 `ErrorCode`、`ProblemDetails` 放在一起;客户端也可以用它判断。shared 是 Apache-2.0,这个类是我们自己写的,没有许可证问题。

## 2. 渠道中枢 → `@fatcat-ai/channels/hub`

- `ChannelHub`、`WechatChannels` 和它们的常量、纯函数(`composeUserText`、`approvalReminder`、`REPLIES` 等)搬到 `packages/channels/src/hub/`,经新的子路径 `@fatcat-ai/channels/hub` 导出。根入口 `@fatcat-ai/channels` 仍然只有适配器、格式化和限流这些轻量的东西,不把 agent / storage 拉进去。
- `packages/channels` 增加依赖 `@fatcat-ai/agent`、`@fatcat-ai/storage`、`@fatcat-ai/providers`、`@fatcat-ai/tools`(都是工作区包,不引入第三方依赖;不成环:这几个包都不依赖 channels)。
- 原来直接 import 的服务器内部函数改成构造参数注入:

| 原来                                                                  | 改成 `ChannelHubOptions` 里的                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `resolveProfile({ repos, secrets }, ownerId, null, sessionProfileId)` | `resolveProfile(ownerId, sessionProfileId)`:找不到可用模型时抛错,中枢照旧回「还没有可用的模型配置档」 |
| `removeOwnerSessions({ repos, runs, files, warn }, ownerId, ids)`     | `removeSessions(ownerId, ids, warn)`                                                                  |
| `files: AttachmentFiles`                                              | 不再需要(只被上面那个函数用)                                                                          |
| pino `Logger`                                                         | `ChannelLogger`:只有 `info(fields, msg)` / `warn(fields, msg)`,pino 的 `Logger` 天然满足              |

`apps/server/src/app.ts` 负责把会话路由里的 `resolveProfile` 和 `session-delete.ts` 包成这两个函数传进去。日志字段、文案和行为都不变(ADR 0022 的「不记外部账号、正文、令牌」照旧)。

- `WechatChannels` 抛的 `ApiError` 改成 `ServiceError`;HTTP 响应不变。
- 测试:`apps/server` 里经 `createTestServer` 走 HTTP 的渠道测试(`channels.test.ts`、`wechat-login.test.ts`、`channel-injection.eval.test.ts`)留在原处,只改 import 路径;它们本来就覆盖了整个中枢。这些测试跑的是包的构建产物,算不进 `packages/channels` 的覆盖率,所以 `packages/channels/vitest.config.ts` 的覆盖率统计排除 `src/hub/**`,并写明由哪些测试覆盖。包级别的中枢单测(用假的仓储和运行管理)随 QQ 渠道一起补,那时两种适配器共用一套测试替身。

## 3. 插件服务 → 新包 `@fatcat-ai/plugins`

- 新建 `packages/plugins`(AGPL-3.0-only),搬入 `PluginService`(`plugin-setup.ts`)、`MarketService`(`plugin-market.ts`)、插件条目(`plugin-items.ts`)与插件文件的备份 / 回退(`plugin-files.ts`),以及 `plugin-files.test.ts`。
- 为什么不放进 `@fatcat-ai/tools/plugins`:插件服务要用 `@fatcat-ai/items`(插件条目)和 `@fatcat-ai/storage`,而 `items` 依赖 `tools`,放进 tools 会成环。运行时(子进程、隔离、预加载)仍在 `tools/plugins`,新包只做「安装、升级、回退、市场、条目、状态」这层服务。
- 依赖:`@fatcat-ai/shared`、`@fatcat-ai/storage`、`@fatcat-ai/tools`、`@fatcat-ai/items`;不引入第三方依赖。
- `SERVER_VERSION` 改成构造参数 `coreVersion`(服务器传自己的版本,测试可以传别的);`ApiError` / `notFound` 改成 `ServiceError` / `notFoundError`。
- 包内的文件改名去掉 `plugin-` 前缀:`service.ts`、`market.ts`、`items.ts`、`files.ts`,经根入口 `@fatcat-ai/plugins` 导出。服务、市场与条目由 `apps/server` 的集成测试覆盖(跑的是构建产物),包的覆盖率统计排除这三个文件,只算 `files.ts`(它的单测随包搬过来);和第 2 节的渠道中枢同样处理。
- `docker/Dockerfile` 的运行镜像多拷一个 `packages/plugins`。
- 经 `createTestServer` 走 HTTP 的 `plugins.test.ts`、`plugin-market.test.ts`、`skills.eval.test.ts` 留在 `apps/server`,只改 import 路径。

## 4. 不变的东西

- `/api/v1` 与 WebSocket 协议:不改。`check-openapi-breaking` 必须通过,`openapi/v1.json` 应该一字不变。
- 数据库、迁移、设置、数据目录结构:不改。
- 日志字段与文案、渠道回复文案、错误码:不改。
- 许可证:新包和搬过去的文件都是 AGPL-3.0-only(SPDX 头不变);shared 里新增的 `ServiceError` 是 Apache-2.0。

## 5. PR 拆分

一次只开一个,上一个合并后从最新的 `main` 切下一个:

1. `refactor/channels-hub`:本 ADR、`ServiceError`、渠道中枢下沉(第 1、2 节)。
2. `refactor/plugin-service`:新包 `@fatcat-ai/plugins`(第 3 节)。

每个 PR 的验收:lint / typecheck / 全部测试 / e2e 照旧通过;`openapi/v1.json` 不变;`apps/server` 里不再有对应模块的业务代码,只剩装配(`app.ts`)和路由。

## 6. 待业主决定

- 渠道中枢放进已有的 `@fatcat-ai/channels`(子路径 `/hub`),而不是新建 `@fatcat-ai/channel-hub`。推荐:放进已有包。少一个包,QQ 适配器和中枢在同一个包里一起测;子路径保证只用适配器的代码不会把 agent 拉进来。
- 插件服务新建 `@fatcat-ai/plugins`。推荐:新建(第 3 节的成环原因)。

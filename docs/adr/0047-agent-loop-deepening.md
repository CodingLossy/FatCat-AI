# ADR 0047 · Agent 循环深化:工具分组、预算停止、提示注册表(M13)

- 状态:已采纳(业主 2026-11-21 定稿 M13 前段方案)
- 日期:2026-11-21
- 相关:ADR 0010(工具与审批)、ADR 0039(预授权与域名范围)、ADR 0042(多智能体)、ADR 0043(i18n)、`docs/milestones/M13-plan.md`
- 语言:中文;代码标识符、API 路径和文件名保留英文。

## 0. 背景

工具越来越多(内置、邮件、浏览器、MCP、插件),每一步都把全部工具说明发给模型:占上下文、拖慢回答,也让模型更容易调错工具。普通对话的工具步数上限 5 太紧,而放宽步数需要另一道刹车。模型看的提示散在四个包里,改动没有版本,日志和评测无法说清用的是哪一版。

本 ADR 定三件事,分别在 M13 前段 PR 2(第 1、2 节)和 PR 3(第 3 节)实现。PR 1 只拆分 `packages/agent/src/runner.ts`,不改行为(见第 5 节)。

## 1. 工具分组与按需开启

### 1.1 分组规则

- 工具名第一个 `.` 之前的部分就是组名:`fs.read` → `fs`。
- MCP 工具的组名是 `mcp.<server>`(`mcp.notes.add` → `mcp.notes`),插件工具是 `plugin.<id>`(`plugin.weather.forecast` → `plugin.weather`)。
- 没有 `.` 的工具(`calc`、`time`、`delegate`)各自独立成组。
- `ToolDefinition` 可以显式给出 `group`;不填时由注册表按上面的规则推出(`groupOf(name)`)。

### 1.2 核心组与按需组

| 类别                      | 组                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------- |
| 核心组(始终交给模型)      | `memory`、`calc`、`time`、`items`、`kb`、`ui`、`delegate`、`tools`(`tools.enable`) |
| 服务端注册的任务类工具组  | 无(见下)                                                                           |
| 按需组(默认不交,需先开启) | 其余全部:`fs`、`mail`、`web`、`browser`、`channel`、`system`、`mcp.*`、`plugin.*`  |

**任务类工具的核对结果(2026-11-21,`main` cd64bb6):**`apps/server` 注册的工具是 `calc`、`time`、`delegate`、`ui.panel`、`items.*`、`kb.search`、`memory.*`、`fs.*`、`mail.*`、`web.fetch`、`browser.*`、`channel.push`、`system.open`(见 `apps/server/src/tools.test.ts` 的工具表)。定时任务通过 `/api/v1/tasks` 接口和界面创建,没有注册给模型的任务类工具,所以核心组不增加。以后新增任务类工具时,在这张表里补上并归入核心组。

### 1.3 `tools.enable`

- 工具名 `tools.enable`,属于核心组;参数 `{ group: string }`;返回该组的工具名和每个工具的一句话说明。
- `risk: 'read'`,不需要审批,预授权不受限制。
- 组不存在,或者被当前任务 / 代理的 `toolSet` 排除时报错,错误文案与 `unknownToolReason` 一致。
- 开启只在本次运行内有效:不跨运行,不写库,不按会话持久化。
- **开启一个组不改变组内任何工具的风险等级、审批要求、预授权与 `forceApproval`。**它只决定工具说明是否交给模型。
- activityLabel 的中英文放在 `packages/i18n`。

### 1.4 与 toolSet 的关系

- 任务或代理的 `toolSet` 里点名的工具或前缀,不论属于哪个组,都直接视为已开启。已有的定时任务和代理行为因此不变。
- `toolSet` 仍然只缩小(ADR 0042 第 2 节):`tools.enable` 不能开启 `toolSet` 之外的组。
- 不在核心组、不在本次运行已开启的组、也没被 `toolSet` 点名的工具不交给模型;模型硬调用时返回 `unknown tool: <name> (enable group <g> with tools.enable first)`,按未知工具审计,不执行。
- 系统提示末尾加一行按需组目录:`Optional tool groups (turn one on with tools.enable): fs (local files in folders the user allowed), mail (e-mail), …`,每组说明不超过 8 个词,文字放在 i18n 的提示模板里(第 3 节的 `tools.groupCatalog`)。目录行放在时间行之前,时间行仍是最后一行(ADR 0023 第 4 节);目录只列本次运行能开启的组(在设置里关闭的、被任务前缀扣下的不列)。

### 1.5 实现细节(PR 2)

- **按需组什么时候生效:**注册表里有 `tools.enable`、且本次运行没有任务或代理的 `toolSet` 时。有 `toolSet` 时,能通过它的工具都是被点名的,等于已开启,行为与以前完全相同;注册表里没有 `tools.enable` 时(例如只注册了几个工具的嵌入场景)无法开启,也就不扣下。子运行总有代理的 `toolSet`,所以按需组只影响普通对话和没有 `toolSet` 的定时任务。
- **输出到渠道的定时任务**一开始就开启 `channel` 组:任务提示要求用 `channel.push` 发出结果(ADR 0034 第 3 节),`channel.push` 每次仍要审批。
- 同一步里先调 `tools.enable` 再调组内工具也可以:一步里的调用按顺序执行,开启后紧接着的调用已可用。审批与审计不受影响。
- `tools.enable` 的报错:组不存在时 `unknown tool group: <g>`;组内工具都被工具集排除时 `unknown tool group: <g> (not in this task's tool set)`,括号里的说法与 `unknownToolReason` 相同;组内工具在设置里全部关闭时 `tool group <g> is turned off in settings`。
- 判断写在 `packages/agent/src/run/tool-step.ts` 的 `isWithheld` 一处:交给模型的 specs 与硬调用的检查用同一条规则,不会不一致。`ToolRegistry` 只提供 `groupOf(name)`。

## 2. 步数与预算停止

- 普通对话的工具步数上限 `MAX_TOOL_STEPS` 从 5 改为 10。`AgentRole.maxSteps` 的 schema、默认值和上限不变。
- 普通对话与定时任务新增每次运行的 token 预算 `DEFAULT_RUN_TOKEN_BUDGET = 60_000`:累加所有步骤 usage 的 `totalTokens`(没有时用输入加输出)。超出后不再开始下一步,按现有的 `stopped = 'budget'` 结束,并给出现有的预算用尽提示。
- 代理运行沿用 ADR 0042 第 3 节已有的预算(`budgetTokens` / `budgetSeconds`,沿委派树共享),不改。
- 实现(PR 2):根运行原来没有预算停止,`stopped = 'budget'` 只存在于委派结果里。为了不改 WebSocket 协议,普通对话与定时任务用完预算时不新增 `run-finished` 的 reason:在本步工具结果回填之后不再请求模型,把 i18n 模板 `runBudget` 的一句说明作为文字追加到回答末尾,以 `reason: 'stop'` 正常结束。

## 3. 提示注册表

- 注册表放在 `packages/i18n/src/prompts.ts`,在现有的 `templates` 上扩展,不新建包。
- 每条提示有固定 `id` 和整数 `version`(从 1 开始)。改动文字时 `version + 1`,同时更新本 ADR 的附表。
- `en` 必填,`zh-CN` 可选,缺失时回落 `en`(与现在一致)。
- `promptRef(name): string` 返回 `"<id>@<version>"`,给日志和评测记录用。**日志只记 ref,不记全文。**
- 未知的 name 在编译期报错。
- 依赖方向:`packages/memory` → `@fatcat-ai/i18n`,不能反向。
- `pnpm check:i18n` 增加一条规则:`packages/*/src` 与 `apps/server/src` 里禁止新出现以 `_PROMPT = [` 开头的常量定义;保留的别名写进 `scripts/i18n-allowlist.json`。

### 附表:注册表里的提示

| id                     | version | 来源(迁移前)                                         | 别名             |
| ---------------------- | ------- | ---------------------------------------------------- | ---------------- |
| `system.base`          | 1       | `packages/agent/src/runner.ts` 的 `SYSTEM_PROMPT`    | `SYSTEM_PROMPT`  |
| `conversation.summary` | 1       | `apps/server/src/agent-setup.ts` 的 `SUMMARY_PROMPT` | 无               |
| `memory.extract`       | 1       | `packages/memory/src/extract.ts` 的 `EXTRACT_PROMPT` | `EXTRACT_PROMPT` |
| `memory.sleep`         | 1       | `packages/memory/src/sleep.ts` 的 `SLEEP_PROMPT`     | `SLEEP_PROMPT`   |
| `tools.groupCatalog`   | 1       | 第 1.4 节的按需组目录行(PR 2 新增)                   | 无               |
| `currentTime`          | 1       | 原 `templates` 的时间行(ADR 0023)                    | 无               |
| `usingTool`            | 1       | 原 `templates` 的「正在使用」状态文字                | 无               |
| `runBudget`            | 1       | 第 2 节的预算用尽说明(PR 2 新增)                     | 无               |

迁移时文字逐字不变;中文版提示另开 PR,需要评测对比。

实现(PR 3):

- 注册表就是原来的 `templates`,扩成 `{ version, en, 'zh-CN'? }`,值可以是字符串或模板函数;用 `as const satisfies` 保留键名,所以 `PromptName` 是字面量联合,未知的名字编译期报错。原来已有的三条短文案(`currentTime`、`usingTool`、`runBudget`)也带上 version,id 沿用原键名。
- `memory.extract` 原文里的 `at most ${MAX_ITEMS_PER_TURN} items` 在注册表里写成字面量 `3`,由 memory 包的单测保证两者一致。
- 记忆生成日志的 `prompt_version` 列原来写提示原文 SHA-256 的前 12 位,现在写 `promptRef`(`memory.extract@1`、`memory.sleep@1`)。列不变,不写迁移;旧行保留哈希值。
- 服务端「记忆抽取失败」的 pino 日志带 `prompt: 'memory.extract@1'`。

## 4. 契约影响

- `packages/shared` 的 `ToolInfo` 增加可选的 `group: string`:`GET /api/v1/tools` 的响应多一个可选字段,属于 `/api/v1` 的向后兼容增量;OpenAPI 文档同步更新,`check-openapi-breaking` 必须通过。
- 不改 WebSocket 协议,不加数据库表或列,不写迁移。

## 5. 实现拆分(PR 1 的重构)

为了让 PR 2、PR 3 的改动落在小文件里,PR 1 先把 `RunManager` 拆开,不改任何行为、文案或默认值:

| 模块                                        | 内容                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/agent/src/runner.ts`              | `RunManager` 的公开方法、运行生命周期和主循环;`MAX_TOOL_STEPS`、`RunConflictError`          |
| `packages/agent/src/run/context-builder.ts` | `SYSTEM_PROMPT`、`currentTimeLine`、系统消息、记忆上下文、摘要与最近原文的组装              |
| `packages/agent/src/run/tool-step.ts`       | `isWithheld`、`unknownToolReason`、`toolContextFor`、一步里的工具调用、结果回填与不可信标记 |
| `packages/agent/src/run/approval-gate.ts`   | 预授权匹配(含任务级白名单)、`decide`、审批请求、等待与超时、用户决定、审计                  |
| `packages/agent/src/run/delegation.ts`      | `delegate`、`mayDelegate`、子运行循环、`Budget`、`Limiter`、委派上限常量                    |
| `packages/agent/src/run/common.ts`          | 共用类型(`RunManagerOptions`、`StartRunInput`、`LoopCtx`、`RunHost` 等)与小工具             |

各模块通过 `RunHost`(选项、时钟、事件写入、任务运行表、等待中的审批)访问 `RunManager` 的内部状态;`packages/agent` 的导出名和签名不变。

## 6. 不做

- 界面上的组开关(放到 Skills 界面,ADR 0048)。
- 按会话持久化开启状态。
- 改任何提示文字或加中文版提示。

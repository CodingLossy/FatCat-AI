# ADR 0034 · 任务的动作、输出与无人值守的安全规则

- 状态:提议(M6 PR 3 `feat/task-actions`;本 PR 无数据库迁移)
- 日期:2026-11-17
- 相关:M6 方案第 2、4 节;ADR 0010(工具与审批)、ADR 0016(不可信内容)、ADR 0022 第 6、7 节(渠道审批与出站)、ADR 0033(调度器)
- 契约代码:`packages/shared/src/tasks.ts`(`agent_prompt`、`TaskOutput`、`allowedTools`);`apps/server/src/scheduler/agent-task.ts`、`channel-push-tool.ts`;`packages/agent/src/runner.ts`(`StartRunInput.task`)

## 决定

### 1. 动作 `agent_prompt`

任务到点时,服务器新建一个会话(标题为任务名),把提示词作为用户消息交给 Agent,用默认对话配置档运行。提示词前加一段由 core 生成的固定说明(「无人值守;需要审批的事会等主人并过期;不要循环重试」),**不含任何用户或外部内容**。每次运行一个新会话,运行记录的 `sessionId` 指向它,Web 可以打开。

提示词只能由主人经 Web / API 创建或修改(会话认证);邮件、网页、渠道消息的内容不能创建或修改任务。固定工具链 `tool_chain` 本 PR 不做,留待需要时再加。

### 2. 审批规则不变

任务里的每次工具调用走与聊天完全相同的策略(ADR 0010 第 2 节):`read` 自动,`write` 需审批,`external` / `dangerous` 每次审批、不可预授权。无人审批时 30 分钟后过期 = 拒绝,运行记为失败并带错误码 `approval_expired`(被拒绝为 `approval_rejected`),**不重试**。审批请求照常出现在 Web 的审批弹窗;任务会话不是渠道的会话,所以本 PR 中审批提醒不会推到微信(见待决定问题)。

### 3. 输出去向与 `channel.push`

- `conversation`(默认):结果留在任务会话里。
- `channel`:任务要求模型用 `channel.push` 把结果发给主人。该工具 `risk = external`、`preauthorizable = false`:**每次都要审批**,服务器对 `remember` 返回 400。
- **目标只来自任务配置**:`channel.push` 的入参只有 `text`;目标渠道取自 `ToolContext.task.channelId`(core 从任务配置填入),模型或工具结果里写的任何渠道 id、收件人都被忽略。发送对象只能是该渠道已绑定的主人账号(`ChannelHub.push`),渠道必须启用且已绑定;不在任务里调用时工具报错。ADR 0022 第 7 节「主动推送只有三类」增补为第四类:定时任务经审批的推送;1.0 仍不提供发给任意联系人的工具。
- 审批卡片的摘要显示将要发送的文本(前 300 字,纯文本)。
- 运行结束后核对:要求了渠道输出但没有一次 `channel.push` 被批准时,运行记 `output_failed`。
- 邮件输出:本 PR 不做一等的邮件输出。需要时提示词里可以让助手用现有的 `mail.draft` + `mail.send`(`mail.send` 同样每次审批)。

### 4. 任务级预授权白名单

`policy.allowedTools`:`[{ tool, constraint? }]`,默认空。服务器在创建与修改时校验:工具必须存在且 `isPreauthorizable`(`external` / `dangerous` 与声明了 `preauthorizable: false` 的工具一律 400);约束沿用 ADR 0010 第 3 节。白名单只对这个任务的运行生效:运行时由 `RunManager` 合成「只在本会话有效」的预授权参与 `decide`,**不写入全局预授权表**;任务被停用、删除或白名单被改动即失效。即使有人绕过 API 把 `external` 工具写进库里,`decide` 对不可预授权的工具根本不看预授权,仍然要审批(有测试)。使用白名单的调用写审计,摘要末尾加「(via task <id>)」(同 ADR 0022 的 `via` 做法,不改 `AuditEntry` 结构)。

### 5. 不可信内容

任务会话与聊天一样:读到邮件、网页等外部内容后,会话的 `untrustedContentSeen` 为真,条件预授权失效(ADR 0016 第 7 节)。任务的提示词里没有事件内容(事件触发在后续 PR)。

### 6. API(新增)

`POST /tasks`(`TaskCreate`:名称、触发器、`agent_prompt`、输出、可选策略);`PATCH /tasks/{id}` 可改 `action`、`outputs`、`policy.allowedTools`(系统任务不可改动作与输出);`Task` 增加 `outputs`,`TaskRun` 增加 `sessionId`,均为响应里的新增字段(ADR 0004、0030 的向后兼容增量)。渠道必须属于主人,否则 400。

## 后果

- 「每天 8 点把摘要发到微信」可以创建,但每天都需要主人在网页审批弹窗里批一次才会发出;没人批就什么都不发。这是业主规则「发渠道消息一律走审批」的直接结果。
- 模型调用成本:每次任务运行是一次完整的 Agent 运行,走现有的对话配额;全局每日上限与并发设置留到下一步。

## 补充:白名单与不可信内容(PR 3 审查后)

任务白名单里的 read / write 工具,在任务会话读到不可信内容(邮件、网页、文件)之后**仍按预授权直接执行**,沿用 ADR 0010 会话预授权的语义;这是有意为之:白名单由主人在 Web 上明确确认,且只能是 read / write 级别,发信、推送、命令等 external 工具永远不在其中。想要更严,就不要把 write 工具放进白名单。以后若要改成「见过不可信内容后退回审批」,需要新的 ADR。

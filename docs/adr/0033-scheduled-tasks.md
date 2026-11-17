# ADR 0033 · 定时任务:任务模型与通用调度器

- 状态:提议(M6 PR 2 `feat/scheduler-core`;含数据库迁移 0016,待业主确认)
- 日期:2026-11-16
- 相关:M6 方案(`docs/milestones/M6-plan.md`)第 2、3、8 节;ADR 0004(API 约定)、ADR 0007 第 5.7 节(维护任务)、ADR 0010(审批)、ADR 0018(内存预算)、ADR 0023(用户时区)、ADR 0030(`/api/v1` 冻结后的增量规则)
- 契约代码:`packages/shared/src/tasks.ts`;存储 `packages/storage/src/tasks.ts`;调度器 `apps/server/src/scheduler/`

## 背景

维护任务原来是 `maintenance-setup.ts` 里一个专用的 croner 定时器,没有运行记录,错过的靠「启动后 10 分钟补跑」。M6 要有通用的任务模型和调度器,先把它迁过去,保证行为不退步,再在后续 PR 里接动作、输出与事件触发。

## 决定

### 1. 任务与运行记录(只新增,不改旧表)

- `tasks`:`kind`(`user` / `system`)、`status`(`draft` / `active` / `completed`)、`enabled`、`trigger_json`、`action_json`、`outputs_json`(PR 3 起使用)、`policy_json`、`system_key`(每个主人唯一,用来幂等创建内置任务)、`last_fired_at`(最近一次已触发的计划时刻,用来判断关闭期间错过了什么)。
- `task_runs`:`trigger_reason`(`schedule` / `catch_up` / `manual` / `event` / `retry`)、`scheduled_for`、`status`、`attempt`、`error_code`、`started_at`、`finished_at`;`session_id` / `run_id` / `outputs_json` 为后续 PR 预留。
- **只存元数据**:状态、错误码(枚举)、时间。不存提示词之外的正文、模型输出、邮件内容、请求体或错误堆栈。每个任务只保留最近 200 条,写入时清理。

### 2. 触发器与动作(只增不改)

PR 2:触发器 `cron`(5 段,用户时区,最小间隔 1 分钟,不接受秒级与别名)和 `once`;动作 `system`(内置)。事件触发器、`agent_prompt`、`tool_chain` 在后续 PR 以新的 `kind` 加入;客户端必须把不认识的 `kind` 当作「不认识的任务」显示(ADR 0004)。

### 3. 调度器语义

- **单一定时器**:指向所有任务里最近的下一次触发,最长睡 5 分钟再检查一次,因此设备休眠醒来后不会等很久。下一次时刻只用 croner 计算(`paused` 实例,不启动它自己的定时器)。
- **时区**:唯一来源是 `Settings.timeZone`(ADR 0023)。改时区后所有任务重新计算下一次。夏令时沿用 croner 11 的行为(跳过的时刻在第一个有效时刻补一次,重复的只跑一次)。
- **错过**:
  - 启动时,用 `last_fired_at`(没有则用创建时间)算出关闭期间错过的触发,**只补一次**,不论错过几次;`catchUp` 在启动 10 分钟后入队,`skip` 只写一行 `missed`;错过超过 24 小时一律当 `skip`。
  - 运行中醒来时发现落后超过 5 分钟(休眠、卡顿)按同样规则处理。
  - 一次性任务启动时已过期:`catchUp` 补跑一次,`skip` 记 `missed` 并标为 `completed`。
  - 默认:用户 cron 任务 `skip`,一次性任务 `catchUp`,系统任务 `catchUp`。
- **并发**:全局默认同时 2 个运行(超出的排队,队列上限 20,满了丢弃最旧的并记 `queue_full`);同一任务同一时刻最多一个,重叠的触发记 `overlap`(手动运行则返回 409)。
- **重试**:只对可重试的失败(超时等)重试,默认最多 3 次尝试,间隔 1、5、15 分钟,**重试写在同一条运行记录的 `attempt` 上**;审批被拒绝、配置错误不重试。
- **推迟(系统忙)**:动作返回 `postponed` 时 10 分钟后再试,不消耗重试次数,最多 12 次,与旧维护任务一致;用尽记 `failed`/`postponed`。
- **静默时段**:任务级,用户时区,可跨午夜。静默期间到点:`skip` 记一行 `quiet_hours`;`defer`(默认)推迟到静默结束后运行一次,多次合并为一次。静默时段只决定「何时执行」,不改变任何审批规则。
- **最长运行时间**:默认 10 分钟(系统任务 30 分钟);超时中止记 `timeout`(可重试)。
- **取消与关闭**:用户可取消排队或运行中的记录;关闭时未结束的记录标为 `cancelled`,启动时遗留的 `queued` / `running` 也标为 `cancelled`(`internal`),**不恢复执行**,与审批的重启语义一致(ADR 0010 第 5 节)。

### 4. 维护任务的迁移

`memory.maintenance` 成为系统任务(cron `30 3 * * *`,`catchUp`),动作调用原来的 `MaintenanceRunner.runAll`;忙时返回 `postponed`,由调度器 10 分钟后重试。各维护子任务自己的日期键仍保证「同一天不跑两次」。附件清理与渠道去重表清理两个轻量的每日任务仍用 `scheduleDaily`(它们没有用户可见的状态,不值得有运行记录),`startMaintenance` 只保留运行器。

### 5. API(`/api/v1`,全部为新增)

`GET /tasks`、`GET /tasks/{id}`、`PATCH /tasks/{id}`(启停、改 cron 或策略;系统任务不可改名)、`DELETE /tasks/{id}`(系统任务 409)、`POST /tasks/{id}/run`(已有排队或运行中的记录时 409)、`GET /tasks/{id}/runs`、`GET /task-runs/{id}`、`POST /task-runs/{id}/cancel`、`GET /tasks/schedule-preview`。`POST /tasks`(用户自建)随 M6 PR 3 加入。方案里计划的 WebSocket `task-run-updated` 事件本 PR 不做:Web 在有运行进行时每 3 秒轮询,事件留到有需要时再加(可选事件类型,是向后兼容的增量)。

### 6. 迁移 0016 与回滚

只新增 `tasks`、`task_runs` 两张表与三个索引,不改已有表和数据。回滚 = `DROP TABLE task_runs; DROP TABLE tasks;`(先停服务器并备份数据目录,迁移器本来就在升级前备份);回滚后旧版本启动时看不到这两张表,维护任务由旧代码接管。

### 7. 内存

调度器常驻状态:一个定时器、每个启用任务一个 `Date`、队列(≤ 20)。不为每个任务建 croner 定时器。目标:0 个用户任务时空闲增量 ≤ 3 MiB,100 个启用任务 ≤ 5 MiB(M6 方案第 7 节);PR 描述附实测。

## 后果

- 维护任务现在有运行记录,Web 可见;改时间或停用不再需要改代码。
- 错过的判断依赖 `last_fired_at`;手动运行不更新它,所以手动运行不会让系统误以为「已经跑过今天那次」。
- 一个新的存储仓储 `repos.tasks` 与两张表;其他包不直接碰它们(AGENTS.md 目录约定)。

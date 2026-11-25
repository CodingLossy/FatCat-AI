# M13 方案 · 前段:Agent 循环深化与 Skills

设计记录见 [ADR 0047](../adr/0047-agent-loop-deepening.md)(工具分组、预算停止、提示注册表)与 ADR 0048(Skills,前段 PR 4 写)。开发计划第 9 节 M13 原本是「稳定化与 2.0」;业主 2026-11-21 决定前段先做 Agent 循环深化与 Skills,QQ 渠道和多用户排在后面。

## 规则

- 顺序固定:PR 1 → PR 2 → PR 3 → PR 4。一次只开一个功能 PR,上一个合并后从最新的 `main` 切下一个。
- 本组不新增数据库迁移;PR 4 只写文档。
- 提交作者和提交者都是业主身份,不加任何署名或尾注;PR 描述包含改了什么、怎么测的、截图(有界面改动时)、还没验证的、需业主决定的,最后是「全窗口通用 PR 摘要」。
- 每个 PR 另有一份真实模型下的手工测试清单,由业主另开窗口执行;本方案只记开发部分。

## 前段四个 PR

### PR 1 · `refactor/runner-split`:拆分 runner,定 M13 方案与 ADR 0047

- 文档:本文件;ADR 0047(已采纳),三节:工具分组、预算停止、提示注册表,取值见 PR 2、PR 3;契约影响只有 `ToolInfo` 增加可选的 `group`(`/api/v1` 向后兼容增量,不改 WS 协议)。
- 重构,不改任何行为:`packages/agent/src/run/` 下拆出
  - `context-builder.ts`:系统提示、时间行、记忆上下文、`planContext` / `toChatMessages` 的组装;
  - `tool-step.ts`:单步工具调用,`isWithheld`、`unknownToolReason`、`toolContextFor`、结果回填与不可信标记;
  - `approval-gate.ts`:预授权匹配、会话内已批准、`forceApproval`、审批等待与超时、审计写入;
  - `delegation.ts`:`delegate`、`mayDelegate`、子运行的预算与深度、`MAX_DELEGATE_TEXT`、`DEFAULT_DELEGATE_PARALLELISM`;
  - `common.ts`:上面几个模块共用的类型(`RunManagerOptions`、`StartRunInput`、`LoopCtx` 等)和小工具。
- `runner.ts` 只保留 `RunManager` 的公开方法、运行生命周期和主循环,不超过 450 行;`packages/agent` 的导出名和签名一个都不变。
- 测试不新增,已有测试不改断言。验收:agent 包测试、server 的 `chat` / `agents` / `agent-delegation.eval` 测试全过,lint、typecheck、`check:spdx` 通过。

### PR 2 · `feat/tool-groups-budget`:工具分组、按需开启、预算停止

- 分组:工具名第一个 `.` 之前是组名;MCP 工具是 `mcp.<server>`,插件工具是 `plugin.<id>`;没有 `.` 的工具各自成组。
- 核心组(始终交给模型):`memory`、`calc`、`time`、`items`、`kb`、`ui`、`delegate`、`tools`(`tools.enable` 本身),以及服务端注册的任务类工具组(核对结果见 ADR 0047 第 1.2 节:目前没有)。
- 按需组(默认不交):其余全部,即 `fs`、`mail`、`web`、`browser`、`channel`、`system`、`mcp.*`、`plugin.*`。
- 新核心工具 `tools.enable({ group })`:`risk: 'read'`、不需要审批;只在本次运行内有效,不写库;开启一个组不改变组内任何工具的风险等级和审批。
- 任务或代理的 `toolSet` 点名的工具或前缀直接视为已开启,已有定时任务和代理的行为不变。
- `MAX_TOOL_STEPS` 从 5 改为 10;`AgentRole.maxSteps` 不变。
- 普通对话与定时任务每次运行的 token 预算 `DEFAULT_RUN_TOKEN_BUDGET = 60_000`,超出按 `stopped = 'budget'` 结束;代理运行沿用 ADR 0042 的预算。
- 契约:`ToolDefinition.group?`、`ToolInfo.group?`;系统提示末尾加一行按需组目录。
- 测试:`groupOf` 单测;未开启的组不在 specs 里、开启后出现;越权(代理 `toolSet` 是 `['kb.']` 时 `tools.enable({group:'fs'})` 报错);预算停止;评测 `tool-groups.eval.test.ts`(先开 fs 组再读文件,审批卡照常出现)。
- 不做:界面上的组开关、按会话持久化开启状态、迁移。

### PR 3 · `refactor/prompt-registry`:提示注册表

- 注册表放在 `packages/i18n/src/prompts.ts`,每条提示有固定 `id` 和整数 `version`(从 1 开始,改文字就加一);`en` 必填,`zh-CN` 可选,缺失回落 `en`。
- `promptRef(name)` 返回 `"<id>@<version>"`,日志和评测只记 ref,不记全文。
- 迁入注册表,文字逐字不变:`system.base`(`SYSTEM_PROMPT`)、`conversation.summary`(`SUMMARY_PROMPT`)、`memory.extract`(`EXTRACT_PROMPT`)、`memory.sleep`(`SLEEP_PROMPT`)、`tools.groupCatalog`(PR 2 的按需组目录行)。原导出名保留为别名。
- `packages/memory` 依赖 `@fatcat-ai/i18n`(只能 memory → i18n)。
- `check:i18n` 新规则:禁止新出现 `_PROMPT = [` 开头的常量定义,白名单在 `scripts/i18n-allowlist.json`。
- 测试:迁移前后 `en` 文本逐字一致的快照;`promptRef` 的值;未知 name 编译期报错。验收:记忆评测指标与 `main` 完全相同。
- 不做:改任何提示文字、加中文版提示。

### PR 4 · `docs/adr-0048-skills`:Skills 设计(只写文档)

- ADR 0048(已采纳):Skill 是指令包(`id`、多语言 `name`、给模型看的 `description`、包内 markdown `instructions`、`toolSet`、可选的任务模板);`plugin.json` 增加可选的 `skills[]`,`entry` 可选(纯指令插件不起子进程);`skill.use({ id })` 注入说明并对本次运行开启 Skill 覆盖的组;Skill 的 `toolSet` 与当前代理或任务取交集,只缩小不扩大;三个内置 Skill;不加表、不写迁移。
- Skills 的实现 PR 拆分写进 ADR 0048 第 11 节,并追加到本文件。
- 开发计划第 18 节追加一条调整记录。

## Skills 实现(ADR 0048 第 11 节)

前段四个 PR 合并之后、后段之前,按下面的顺序实现 Skills(一次只开一个,上一个合并后从最新的 `main` 切下一个;都不写迁移):

1. `feat/skills-manifest`:`PluginSkill` schema、`skills[]`、可选的 `entry`、engines 下限与 `toolSet` 限制,安装时解析 instructions;越权用例(纯指令插件声明 `net` 被拒等)。
2. `feat/skills-runtime`:`skill.use`(核心组 `skill`)、系统提示的 Skill 目录、与工具集取交集、不可信包装、代理角色的 `skills`、`GET /api/v1/skills`;越权与注入评测。
3. `feat/builtin-skills`:`mail-assistant`、`web-research`、`local-files` 三个内置 Skill 与每日邮件摘要模板。
4. `feat/skills-ui`:插件页、设置页、代理页的 Skill 显示与开关(附截图)。
5. `feat/skills-market`:索引条目的 `skills`、市场页展示、instructions 话术初筛脚本。

## 语音优先与编码代理(ADR 0049)

业主 2026-11-23 确认新增,插在 Skills 实现第 2 步(`feat/skills-runtime`)之后、后段之前;业主 2026-11-24 定的顺序是 `feat/skills-manifest` → `feat/skills-runtime` → `fix/windows-tests` → 本组。设计见 [ADR 0049](../adr/0049-voice-first-and-code-agent.md)。

0. `docs/adr-0049-voice-code`:ADR 0049、本节、开发计划第 18 节(只写文档)。
1. `feat/voice-first`:默认输入方式(默认语音)、语音模式主界面(说话按钮、点按 / 按住、字幕)、文字输入弹窗、手机。顺带做 X 在 #125 留下的界面项:手机模型菜单的「模型 / 代理」改成两个 `role="group"` 并加 e2e 断言、`placeLabels` 放不下时先换边再放弃(含单测,悬停 / 焦点标签也先试不压气泡的一侧)、`theme.test.ts` 的 import 顺序、390px 下模型胶囊菜单「代理」分组的截图。
2. `feat/voice-continuous`:连续对话(本地 VAD、朗读时打断、静音自动结束);唤醒词不做。
3. `feat/code-agent-tools`:`Settings.code` 登记项目与命令,`git.log` / `git.show` / `git.diff` 只读工具,`code.run` 只运行登记的命令,每次审批,默认关闭,归入按需组 `code`。顺带做 X 在 #128 留下的两项:`server.lock` 被当作运行中时,`secrets migrate` 的报错写出锁文件完整路径与「确认服务器已退出后可手动删除」并加测试;锁里程序名大小写不同(`NODE.EXE` 与 `node.exe`)仍判为同一程序的用例。
4. `feat/code-agent-panel`:右侧「代码」面板(项目、提交列表与差异、正在改的文件差异、测试输出),跟随规则同浏览器面板。
5. `test/voice-command-e2e`:「打开浏览器搜 xxx」与「打开 FatCat-AI 项目、看最近第 3 次改动、修一下 bug」两条假麦克风端到端用例。

界面 PR(1、2、4)的前后对比截图放 `docs/pr-screenshots` 分支 `voice-first/` 与 `code-panel/` 下(桌面三套主题 + 手机),业主确认后再合并;界面文案只在配置和有风险的项旁留一句短提示。

本组待业主真机测试(X 在 #132 列出,不阻断合并):Windows 上 `pnpm test` 经 `pnpm.cmd` → `cmd.exe` 运行(含 `C:\Program Files\nodejs\pnpm.cmd` 这类带空格的路径);取消与超时用 `taskkill /T /F` 结束整个进程树(如 vitest worker);授权文件夹经 junction / 8.3 短路径到达的项目;PATH 里没有 git 时报 `git_unavailable`;项目根目录放一个假的 `cmd.exe` / `git.exe` 不会被运行;真实 Git LFS 仓库的差异里显示指针文本。X 在 #132 留下的非阻断项随 `feat/code-agent-panel` 做:审批卡片把模型追加的 `args` 单独高亮,tool-groups 文档提醒只登记固定用途的命令(`git`、`npx` 这类命令可以被追加 `-c`、`--config=` 等选项);`apps/docs` 构建产物加进 `.prettierignore`。

本组之后回到 Skills 实现第 3–5 步(`feat/builtin-skills`、`feat/skills-ui`、`feat/skills-market`),再进入后段。X 在 #127 留下的项随 `feat/builtin-skills` 一起做:`readInstructions` 在 Windows 上没有 `O_NOFOLLOW` 的注释与「说明文件换成包外符号链接时 `skill.use` 返回 unknown skill」的评测用例;`skill.use` 不受任务 `withholdToolPrefixes` 约束这一点在 ADR 0048 第 6 节写明或改走 `isWithheld`(都要补测试);子运行只自动使用自己代理的 Skill、不继承父运行的用例;以及仍未做的 `secrets.yaml.migrated` 收紧 ACL(#44)和 M10 自检文档里 updater 私钥说法与工作流私钥引用检查(#92)。

## 后段顺序

前段合并之后,按下面的顺序继续(每项开工前先写或更新 ADR):

1. channels hub 与 PluginService 下沉:把渠道中枢和插件服务从 `apps/server` 下沉到对应的包,`apps/server` 只做装配和路由。设计见 [ADR 0050](../adr/0050-server-split.md),分两个 PR:`refactor/channels-hub`(`ServiceError` 与渠道中枢下沉到 `@fatcat-ai/channels/hub`)、`refactor/plugin-service`(新包 `@fatcat-ai/plugins`)。
2. ownerId 覆盖审计:逐个仓储和路由核对 `ownerId` 过滤,补越权用例,为多用户做准备。设计与盘点见 [ADR 0051](../adr/0051-owner-scope-audit.md),PR `test/owner-scope-audit`:`pnpm check:owner-scope` 静态检查与 `apps/server/src/owner-scope.test.ts` 越权扫描。
3. QQ 渠道:QQ 官方机器人(WebSocket 网关、只处理单聊、沿用 ADR 0022 的绑定与审批)。设计见 [ADR 0052](../adr/0052-qq-channel.md),分三个 PR:`docs/qq-channel-adr`、`test/channel-hub-unit`(包级中枢单测)、`feat/channel-qq`。
4. 多用户 ADR(2.0)。设计见 [ADR 0053](../adr/0053-multi-user.md)(账户与角色、管理员才能开的安装级能力、密钥前缀、迁移与回退),PR `docs/multi-user-adr` 只写设计;实现按 ADR 第 12 节分 6 个 PR,在业主确认后的 2.0 里做。

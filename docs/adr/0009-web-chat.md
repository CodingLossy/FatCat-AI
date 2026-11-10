# ADR 0009 · Web 聊天界面(apps/web)

- 状态:提议(M1 方案第 8 节第 8 项 `feat/web-chat`,待业主审阅)
- 日期:2026-11-04
- 来源:开发计划第 5 节 M1、6.1;`docs/milestones/M1-plan.md` 第 1、6、8 节;ADR 0004、0006、0007、0008

## 背景

M1 的 Web UI 要有登录、会话列表、聊天窗口、设置页、深浅色与中英文骨架,验收是「Playwright 冒烟,含流式中刷新页面」。业主另外要求本 PR 包含:记忆列表(查看、编辑、删除)、`memory.save` 的批准 / 拒绝按钮、模型配置档管理(只接受 `env:` / `file:` 引用并显示 `keyStatus`)。

## 决定

### 1. 只走公开 API

- 所有请求经 `@fatcat-ai/client`(ADR 0008),浏览器用 Cookie 会话:登录 / 初始化后服务器下发 HttpOnly 的 `aip_session` 与可读的 `aip_csrf`,修改类请求从 `aip_csrf` Cookie 读出令牌放进 `X-CSRF-Token`。页面里不保存任何令牌或密钥。
- 补上 M1 方案第 5 节已列出但尚未实现的 `GET /settings` · `PUT /settings`(契约早已在 `packages/shared` 的 `Settings` / `SettingsPatch` 中,只是增量新增端点,不改 schema)。`PUT` 只改给出的键,`memory` 浅合并;默认配置档必须存在,否则 400。`defaultChatProfileId` / `defaultCheapProfileId` 现在参与选择配置档:请求指定 > 会话设置 > 设置中的默认值 > 第一个声明该用途的配置档。SDK 增加 `settings.get()` / `settings.update()`。

### 2. 依赖从简

M1 方案原列了 TanStack Router / Query、Tailwind、i18next。页面只有四个,为控制体积与依赖面,改为:

| 需要         | 做法                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| 路由         | 自写约 40 行的 History API 路由(`/`、`/s/:id`、`/settings`、`/memory`),服务器已有 SPA 回退 |
| 数据请求     | 组件内 `useEffect` + SDK,不引入缓存层                                                      |
| 样式与深浅色 | 原生 CSS 变量;`<html data-theme>` 取 `system` / `light` / `dark`                           |
| 中英文       | `src/i18n.ts` 两份字典 + `t(key, vars)`;M9 再迁到 `packages/i18n`(i18next)                 |
| Markdown     | `react-markdown`(MIT),不启用原始 HTML;代码块带「复制」按钮;代码高亮留到以后                |
| 端到端测试   | `@playwright/test`(Apache-2.0,仅开发)                                                      |

唯一新增的运行时依赖是 `react-markdown` 及其 unified 依赖树(均为 MIT / ISC 等宽松许可,`pnpm check:licenses` 通过)。Web UI 只以静态文件进入 Docker 镜像,不影响服务器空闲内存。

### 3. 流式与刷新续看

- 发送用 `sessions.send()` 的 SSE 流;事件经纯函数 `applyEvent()`(`src/live-turn.ts`)归并成「进行中的一轮」:正文、工具调用、待审批、工具结果、结束原因。运行结束后重新拉取消息列表,以服务器保存的结果为准。
- 刷新或换页回来时,若会话的 `activeRunId` 不为空,就隐藏该运行尚未完成的助手消息,用 `runs.events(activeRunId, 0)` 从头补发并继续接收事件,重建同一轮的状态(包括尚未处理的审批卡片)。SDK 已负责断线续看与按 seq 去重。
- 停止按钮调用 `POST /runs/:id/cancel`。

### 4. 审批

收到 `approval-required` 时在消息中显示审批卡片(工具名、服务器给出的摘要、入参),只有「批准」和「拒绝」两个按钮,调用 `POST /approvals/:callId`;收到 `approval-resolved` 后卡片显示结果并去掉按钮。页面不会自动批准任何调用(默认需审批)。

### 5. 设置与记忆

- **设置页**:语言、主题(保存到 `/settings`,本地立即生效)、默认对话 / 廉价配置档。
- **模型配置档**:列表显示标签、模型、地址、用途和 `keyStatus`(已设置 / 缺失 / 无需密钥);新增、编辑、删除、连接测试。密钥只能填 `env:NAME` 或 `file:NAME`(与 shared 的 `ApiKeyRef` 相同的正则先在页面校验,服务器再校验),输入框旁说明不接受明文。
- **记忆页**:列表(文本、类型、领域、来源、状态、置信度、时间)、搜索、改文本、删除(`DELETE /memory/:id`,永久遗忘,先确认)。

### 6. 测试

- 单测只覆盖纯逻辑:`applyEvent()` 的事件归并、密钥引用校验;两份字典的键一致由类型(`Record<Key, string>`)在 typecheck 中保证。
- Playwright 冒烟(`pnpm test:e2e`,CI 中单独一步):启动构建后的 server(托管 `apps/web/dist`,临时数据目录)与一个慢速回放 DeepSeek fixture 的假端点,在浏览器里完成:初始化 → 添加配置档(看到 `keyStatus`)→ 发送消息 → **流式中刷新页面** → 回复完整出现;`memory.save` 拒绝与批准两条路径;记忆页编辑与删除。

## 后果

- 以后需要缓存、乐观更新或复杂路由时,再按计划引入 TanStack Router / Query,页面结构不受影响。
- 待业主决定:是否接受用自写路由 / CSS 变量 / 简易字典替代计划中列出的 TanStack、Tailwind、i18next(本 PR 的做法)。

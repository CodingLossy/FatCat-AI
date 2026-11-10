# M1 自检报告

- 日期:2026-11-04
- 基线:`main` @ `1bc5931`(M1 方案第 8 节 PR #1–#9 均已合并,对应 GitHub PR #1–#10;#5 为补录的 DeepSeek fixture)
- 环境:Windows 11,Node 24.15.0,pnpm 10.11.1;本机无 Docker,镜像相关结论来自 GitHub Actions
- 对照依据:开发计划第 8 节 M1 与 6.1 节;`docs/milestones/M1-plan.md` 第 0、6 节与第 9 节业主决定

结论:验收表 10 项中 **6 项通过、4 项部分通过**,没有未开始的项。部分通过的是:Ollama 只做了回放、没有真实手工验收(业主改用 DeepSeek 验收);**覆盖率达标但没有门禁**;OpenAPI 只校验了版本号、没有接 oasdiff;Docker 没有测对话峰值内存。另有两处小的范围差异:代码高亮未做;Web UI 没有用计划列出的 TanStack / Tailwind / i18next。详见第三节。

## 一、验收标准(M1 方案第 6 节)

| #   | 验收项                                                        | 结果        | 依据                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 填入任意 OpenAI 兼容端点(含 Ollama)即可流式对话               | ⚠️ 部分通过 | 回放测试覆盖 OpenAI 风格流(含 usage)、Ollama 风格流(CRLF、跨块切断、无 usage)、工具调用、401 / 429 / 5xx、首包超时与取消(`packages/providers/src/providers.test.ts`)。真实端点:DeepSeek 已录制并回放(`deepseek-*.json`,业主决定 8),OpenRouter 由业主确认可用。**真实 Ollama 没有手工验收**:业主把手工验收端点定为 DeepSeek。Anthropic / Gemini 原生适配已完成,fixture 为按官方格式手写的合成数据 |
| 2   | 刷新页面可续看进行中的回复                                    | ✅ 通过     | 服务端:`apps/server/src/chat.test.ts`「断线续看」验证 `Last-Event-ID` 之后的事件不重不漏、拼接结果与落库正文一致;SDK 自动续看并按 seq 去重(`packages/client/src/client.test.ts`)。Web:Playwright `apps/web/e2e/smoke.e2e.ts` 在流式途中 `page.reload()`,确认续看后回复完整,CI 每次运行                                                                                                           |
| 3   | 未登录访问 API 返回 401                                       | ✅ 通过     | `apps/server/src/app.test.ts`「未登录访问一律 401(遍历全部路由)」枚举应用注册的全部 `/api/v1` 路由(含 openapi.json),除 3 个公开端点外均为 401;另测了伪造 Bearer 令牌、缺少 CSRF 的 403,以及记忆与审批的越权用例(`memory.test.ts`)                                                                                                                                                                |
| 4   | 单测覆盖 providers 与会话存储(覆盖率 ≥ 80%,计划第 11 节门禁)  | ⚠️ 部分通过 | 覆盖率本身达标,但**门禁没有落实**,见第二节                                                                                                                                                                                                                                                                                                                                                       |
| 5   | 录制回放测试通过                                              | ✅ 通过     | `packages/eval` 回放适配器;CI 只跑回放;fixture 落盘前脱敏、去掉请求头,`pnpm check:secrets` 在 CI 中扫描。重录方式是 `AIP_EVAL_LIVE=1 … pnpm --filter @ai-personal/providers test`(见 fixture README),计划中写的 `pnpm eval --live` 命令没有单独做                                                                                                                                                |
| 6   | 6.1:不开 Web UI 用 CLI / curl 完成对话与审批                  | ✅ 通过     | `apps/cli/src/e2e.test.ts` 启动构建后的 server 与回放假端点,依次 `setup` → `models add` → `ask` → `sessions`,并覆盖 `memory.save` 的拒绝与批准两条路径;README 新增完整的 curl 与 PowerShell 流程(初始化 → 令牌 → 配置档 → 会话 → 流式 → 审批 → 续看),已对本地 server 实际跑通到流式输出一步                                                                                                      |
| 7   | 6.1:OpenAPI 可访问                                            | ⚠️ 部分通过 | `/api/v1/openapi.json` 需鉴权可访问(`app.test.ts`);CI 重新导出 `apps/server/openapi/v1.json`,与仓库内文件比对后上传为构建产物,作为以后检测破坏性变更的基线。**没有用 OpenAPI 校验器校验**(测试只检查 `openapi: 3.1.0` 与路由列表);计划 6.1 的 oasdiff 破坏性变更检测也还没接                                                                                                                     |
| 8   | 6.1:WebSocket 断线重连补发事件                                | ✅ 通过     | `apps/server/src/ws.test.ts`「lastSeq 之后的事件先补发再实时推送,断线重连不重不漏」;另测了未登录 / 缺少同源 Origin 时拒绝握手、ping / pong、非法帧                                                                                                                                                                                                                                               |
| 9   | 记忆 v1:`memory.save` / `memory.search`;UI 查看 / 编辑 / 删除 | ✅ 通过     | `apps/server/src/memory.test.ts`:批准后写入、新会话中 `memory.search` 命中(「记住我住杭州 → 我住哪」);拒绝后不写入;含 `sk-…` 的内容被拒存;真实 OpenAI 兼容 provider 回放 `memory.save` 往返。UI:Web 记忆页与 CLI `memory` 子命令,Playwright 覆盖批准 / 拒绝按钮与记忆的编辑、删除                                                                                                                |
| 10  | 镜像资源预算:空闲 RSS < 120 MiB,另测一次对话峰值              | ⚠️ 部分通过 | CI docker 任务断言容器空闲 RSS < 120 MiB,M1 各 PR 实测 94–95 MiB(PR #10 为 95 MiB);M1 没有新增常驻服务。**对话峰值没有测量**:CI 容器里没有可调用的模型端点,这一步没做                                                                                                                                                                                                                            |

## 二、覆盖率门禁:没有落实

计划第 11 节要求核心包覆盖率 ≥ 80%,M1 方案把它列为 providers 与会话存储的验收方式。**目前 CI 不测覆盖率,也没有阈值**:仓库没有 `@vitest/coverage-v8`,各包的 `vitest run` 也没有开启 coverage。

为了这份报告,我在本地临时安装了 `@vitest/coverage-v8` 5.1.0(MIT)测了一次,测完已恢复 `package.json` 与 `pnpm-lock.yaml`,没有提交任何依赖。统计范围是各包 `src/`,不含测试文件与测试辅助文件:

| 包                   | 语句  | 分支  | 函数  | 行    | 是否 ≥ 80%                                                   |
| -------------------- | ----- | ----- | ----- | ----- | ------------------------------------------------------------ |
| `packages/providers` | 89.1% | 72.6% | 87.0% | 93.2% | 语句 / 行达标,分支未达                                       |
| `packages/storage`   | 91.0% | 74.9% | 86.8% | 91.9% | 语句 / 行达标,分支未达                                       |
| `packages/agent`     | 93.8% | 85.0% | 90.9% | 95.4% | 全部达标                                                     |
| `packages/memory`    | 100%  | 87.9% | 100%  | 100%  | 全部达标                                                     |
| `apps/server`        | 83.3% | 75.3% | 85.1% | 86.4% | 语句 / 行达标,分支未达                                       |
| `packages/client`    | 62.6% | 67.2% | 41.4% | 63.9% | 未达(只计本包单测;CLI 与 Web 端到端测试实际走过的代码不计入) |

按计划的口径(providers 与会话存储的行 / 语句覆盖率),**两者都超过 80%**。但没有门禁,以后的改动随时可能把它拉低。

建议作为单独的 PR(本 PR 只写文档,不加依赖):加 `@vitest/coverage-v8`(MIT,仅开发依赖),在 `packages/providers`、`packages/storage`、`packages/agent`、`packages/memory` 的 vitest 配置里设行 / 语句 80% 的阈值,CI 的 `pnpm test` 改为带覆盖率运行。分支覆盖率先不设门槛,或先设 70%。是否要做、阈值定多少,请业主决定。

## 三、范围核对(M1 方案第 0 节与计划第 8 节 M1)

| 范围项                                                                     | 结果        | 说明                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型网关:OpenAI 兼容 + Anthropic / Gemini 原生                             | ✅          | 三种都用 `fetch` 自写,不用 SDK(ADR 0006:AI SDK 加载即 +22 MiB RSS)。Gemini 思考模型的 `thoughtSignature` 未回传,已在 ADR 0006 第 5 节列为已知限制                                            |
| 配置档 CRUD、只接受 `env:` / `file:`、连接测试                             | ✅          | API、CLI、Web 三处都校验;`keyStatus` 显示是否找到密钥                                                                                                                                        |
| `packages/storage`:外键、迁移、备份                                        | ✅          | 手写 SQL 迁移(为了内存去掉了 Drizzle,ADR 0005);每个连接 `PRAGMA foreign_keys = ON`;迁移前备份                                                                                                |
| 会话 / 消息 / 运行;SSE;中断 / 重试 / 重新生成;续看                         | ✅          | `chat.test.ts`                                                                                                                                                                               |
| 上下文窗口管理:cheap 配置档压缩                                            | ✅          | `packages/agent/src/tools.test.ts`「上下文压缩」;摘要失败时丢弃最旧消息并继续运行                                                                                                            |
| 鉴权:初始化、登录、令牌、预留 `ownerId`;TOTP 推迟到 M5                     | ✅          | 登录限速每来源 5 次 / 分钟;日志中不出现密码与令牌(`app.test.ts`)                                                                                                                             |
| 记忆 v1 + 最小审批管道;提前建 `items` / `item_edges` / `memory_facts` 子集 | ✅          | ADR 0007 第 4 节                                                                                                                                                                             |
| `packages/client`、`apps/cli`                                              | ✅          | SDK 零运行时依赖;CLI 用 `node:util` 的 `parseArgs` 代替 citty(ADR 0008,业主已合并)                                                                                                           |
| Web UI:会话列表、聊天(Markdown、**代码高亮**、复制)、设置、深浅色、中英文  | ⚠️ 基本完成 | **代码高亮未做**,代码块只有复制按钮。路由、样式、中英文用自写方案代替 TanStack Router / Query、Tailwind、i18next(ADR 0009 第 2 节,PR #9 已合并);另按业主要求加了记忆页、审批按钮与配置档管理 |
| `GET` / `PUT /settings`                                                    | ✅          | 方案第 3.2 节列出但一开始没做,在 Web UI 的 PR 中补上                                                                                                                                         |

## 四、安全与合规底线

- 默认只监听 `127.0.0.1`;Docker 映射到 `127.0.0.1:8787`,容器以非 root 用户 `node` 运行(CI 检查)。
- 密钥只从环境变量或 `secrets.yaml` 读取;API 与 Web UI 不接收明文;日志写出前统一脱敏;上游错误正文脱敏并截断;fixture 由 CI 扫描。
- 新增依赖都在许可证白名单内(`pnpm check:licenses`,285 个包);只有 Vite 的 lightningcss 是 MPL-2.0,属于未修改的开发依赖。所有源文件都有 SPDX 头,REUSE 检查通过。
- 没有遥测;Web UI 只调用公开的 `/api/v1`。

## 五、待业主决定

1. 是否在下一个 PR 加覆盖率门禁,阈值多少(见第二节)。
2. 是否需要补做:真实 Ollama 手工验收、OpenAPI 校验器与 oasdiff、Docker 对话峰值内存、Web 代码高亮。我的建议是:oasdiff 在 `/api/v1` 正式冻结前接入;其余三项可以放进 M1.x 或 M2 开头。
3. Anthropic / Gemini 的 fixture 目前是合成数据,有密钥后可以重录。
4. 确认 M1 完成后再开始 M2(按约定,我不会自行开始)。

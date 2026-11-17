# ADR 0040 · 插件系统与插件市场(M7 设计)

- 状态:提议(M7 PR 1 `docs/m7-plan`;业主确认后改为已采纳,实现按 `docs/milestones/M7-plan.md` 的 PR 拆分逐个进行)
- 日期:2026-11-17
- 相关:开发计划第 9 节 M7、第 15.5 节(SDK 许可);ADR 0003(条目索引)、0005(存储与迁移)、0010(工具框架与审批)、0012(条目 API)、0013(MCP 客户端)、0016(不可信内容)、0018(内存预算)、0026(密钥加密)、0027(TOTP)、0028(外连清单)、0030(`/api/v1` 冻结)、0039(预授权域名范围)
- 范围:本 ADR 只定设计,不含实现代码。`/api/v1/plugins` 的字段细节在对应实现 PR 里随 OpenAPI 一起提交(只做向后兼容的增量,ADR 0030)。

## 背景

M7 验收:能从市场一键安装一个 MCP 插件和一个原生插件;卸载干净;越权调用被拦截。插件是用户或第三方写的代码,是项目里最大的新攻击面,所以设计的重点是:**插件能拿到什么**(权限)、**能碰到什么**(隔离)、**怎么装、怎么证明它没被换过**(来源与校验)、**怎么走得干净**(卸载)。

## 1. 决定摘要

1. 两种形式:**MCP 插件(首选)**与**原生 TS 插件**(`@fatcat-ai/plugin-sdk`,Apache-2.0)。两者共用同一份 `plugin.json` 清单、同一套安装 / 权限 / 卸载流程。
2. 权限是**上限**,不是授权:清单声明、用户在安装时一次性同意;每次工具调用仍走 ADR 0010 的审批与预授权,权限不能绕过它们。
3. 原生插件跑在**独立子进程**里,只能通过宿主 API(JSON-RPC)做事,读不到数据目录里的 `secrets.yaml`、`master.key`、`db.sqlite`。
4. 安装来源:本地目录、npm 包(精确版本)、GitHub 仓库(固定到提交)。**宿主永远不运行包管理器,也不执行安装脚本**。
5. 市场 = 一个公开 GitHub 索引仓库(JSON + PR 审核),每个版本条目带 SHA-256 校验和;sigstore 可选,不在 M7 必做范围。
6. 卸载是一条有顺序、可重试、可测试的流水线,验收标准是「安装前后数据目录文件树与数据库行数一致」。
7. 新增 2 张表(迁移 0018、0019,见第 8 节);插件管理器按需加载,没有安装插件时空闲内存不变。

## 2. 插件形式

### 2.1 MCP 插件(首选)

- 插件包里带(或指向)一个 MCP Server 的启动方式:`command` + `args`(+ 包内相对路径)。宿主用 ADR 0013 已有的 stdio 客户端连接,**不新增协议实现**。
- 与 ADR 0013 手动添加的 `mcp_servers` 的区别:
  - 由插件管理器生命周期管理(安装 / 启停 / 卸载),不出现在 `mcp_servers` 表;
  - 工具名为 `plugin.{id}.{tool}`(不是 `mcp.*`),来源标为 `plugin`;
  - **子进程环境变量只来自插件自己的设置项**(第 3.4 节),不从宿主进程环境读取。ADR 0013 允许「用户列出名字、值取自服务器进程环境」,这对用户自己配的服务器可以,对市场里第三方声明的名字不行:恶意清单写 `envNames: ["DEEPSEEK_API_KEY"]` 就能拿走宿主的环境变量。
- MCP 插件是**用户权限下的普通进程**,宿主**无法**限制它读写文件或联网。这一点必须在安装界面上写明(第 3.5 节的「强制程度」表),它的安全底线只有两条:工具调用审批,以及输出一律不可信。

### 2.2 原生 TS 插件

- 用 `@fatcat-ai/plugin-sdk` 写,发布成一个**自包含**的 ESM 包(依赖必须打进包里,宿主不跑 `npm install`)。SDK 的能力(全部经宿主 API,见第 4 节):

| SDK 能力                       | 说明                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `tools.register()`             | 注册工具(名称、描述、参数 schema、风险级别)                            |
| `items.registerItemProvider()` | 知识地图条目提供者(计划第 6.2 节),例如「视频数据」                     |
| `settings`                     | 读取自己的设置值(含加密的密钥项);设置页表单由清单声明(第 3.3 节)       |
| `tasks` 模板                   | 清单声明的定时任务模板,用户在任务页「从模板创建」,仍要经 M6 的确认卡片 |
| `net.fetch()`                  | 宿主代发的 HTTP 请求(第 5.3 节)                                        |
| `fs.read()` / `fs.write()`     | 只能访问用户已授权的目录(ADR 0011),经宿主校验                          |
| `kv`                           | 插件私有的小型键值存储(每个插件 1 MiB)                                 |
| `log`                          | 写入宿主日志(带插件 id,不含 secrets)                                   |

- **渠道**(计划里 SDK 的 `registerChannel`)本 ADR 只保留命名空间和权限名 `channel.provide`,**M7 不实现**:渠道涉及绑定、群聊注入、敏感度、审批推送(ADR 0022),需要单独的设计与评测,见 `M7-plan.md` 第 9 节问题 5。
- 插件 UI 只有**声明式**的:设置页表单由清单里的 JSON 字段描述,由宿主渲染。**插件不能向 Web UI 注入 JS、HTML 或 CSS**。这是有意的:Web UI 带着登录会话和 CSRF 令牌,允许插件脚本进入页面等于把整个账号交出去。

### 2.3 许可立场

- SDK 与清单 schema(放在 `packages/shared`)为 Apache-2.0(计划第 15.5 节,已定),第三方插件的许可证由作者自定,市场索引里注明。
- 通过 MCP(独立进程)接入的插件视为独立作品。原生插件与宿主之间只有进程边界和公开的 JSON-RPC 协议;这是项目的立场,**是否构成「衍生作品」属于法律判断,待业主确认文档措辞**(`M7-plan.md` 问题 11)。

## 3. 清单 `plugin.json`

放在插件包根目录,UTF-8 JSON,最大 64 KiB。zod schema 在 `packages/shared`(Apache-2.0),宿主、SDK 的校验命令、索引仓库的 CI 共用同一份。**严格模式**:未知的顶层字段一律报错(防止「新字段悄悄带来权限」);向前兼容靠 `manifestVersion`。

| 字段              | 必填 | 说明                                                                                                           |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | 是   | 固定为 `1`                                                                                                     |
| `id`              | 是   | `[a-z][a-z0-9-]{2,23}`,全局唯一(市场按它去重),安装后不可改。工具名 `plugin.{id}.{tool}` 总长 ≤ 64              |
| `name`            | 是   | 显示名(不可信文本,界面按纯文本显示)                                                                            |
| `version`         | 是   | `x.y.z`(semver 的数字三段;不接受预发布后缀)                                                                    |
| `description`     | 是   | 一句话,≤ 200 字符                                                                                              |
| `author`          | 是   | 字符串;可选 `homepage`、`repository`                                                                           |
| `license`         | 是   | SPDX 标识                                                                                                      |
| `kind`            | 是   | `mcp` 或 `native`                                                                                              |
| `pluginApi`       | 原生 | 原生插件所用的宿主 API 版本,M7 为 `1`                                                                          |
| `minCoreVersion`  | 是   | 最低核心版本 `x.y.z`;低于它的核心拒绝安装(自己写数字三段比较,不引入 semver 依赖)                               |
| `entry`           | 原生 | 入口文件,包内相对路径,必须是 `.js` / `.mjs`                                                                    |
| `mcp`             | MCP  | `{ command, args, cwd? }`;`command` 是 `node` / `python` 之类的解释器名,或包内相对路径的可执行文件             |
| `permissions`     | 是   | 字符串数组,语法见第 3.2 节;可以为空                                                                            |
| `tools`           | 否   | 静态工具声明 `{ name, description, risk }[]`,用于安装前展示;MCP 插件运行时以服务器实际列出的为准               |
| `settings`        | 否   | 设置项声明(第 3.3 节)                                                                                          |
| `taskTemplates`   | 否   | `{ id, name, description, trigger, prompt }[]`,字段限制与 M6 任务一致,不能带预授权                             |
| `i18n`            | 否   | `{ "zh-CN": {...}, "en": {...} }`,可覆盖 `name` / `description` / 设置项标签 / 权限理由;缺项回退英文再回退原文 |

### 3.1 校验规则(安装预览与索引 CI 都执行)

- 解析失败、字段缺失、未知字段、`id` 与目录名 / 索引条目不一致:拒绝。
- 路径类字段(`entry`、`mcp.cwd`、`mcp.command` 为相对路径时)必须落在包目录内,拒绝绝对路径、`..` 和符号链接。
- 描述类字段长度上限;`tools[].name` `[a-z0-9_-]{1,32}`;工具描述截断到 1,024 字符并标注来自插件(沿用 ADR 0013)。
- `minCoreVersion` 高于当前核心:拒绝并说明需要升级到哪个版本。

### 3.2 权限语法与含义

`permissions` 是字符串数组,便于在索引仓库的 PR 里逐行评审、升级时逐项对比:

| 权限              | 含义                                                                                        | 原生插件的强制方式                       |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `net:{域名范围}`  | 允许经宿主代发请求到该范围,语法与 ADR 0039 的预授权域名相同(`example.com`、`*.example.com`) | 宿主代发(第 5.3 节):域名范围 ∩ net-guard |
| `fs.read`         | 读用户已授权目录(ADR 0011)                                                                  | 宿主代发,走现有路径校验                  |
| `fs.write`        | 写用户已授权目录                                                                            | 同上;工具风险下限为 `write`              |
| `items.provide`   | 注册条目提供者;条目 `source` 固定为 `plugin.{id}`                                           | 宿主代理提供者(第 5.5 节)                |
| `tasks.template`  | 提供任务模板                                                                                | 宿主展示,不能自动创建任务                |
| `ui.settings`     | 在设置页显示自己的设置表单                                                                  | 宿主渲染                                 |
| `channel.provide` | **保留**,M7 不接受                                                                          | —                                        |

- `net:` 复用 `parseDomainScope`,`*.com` 这类过宽的写法(`broad`)、带协议 / 路径 / 端口的写法**在清单校验时就拒绝**,与 ADR 0039 的输入校验同一套规则。`*.example.com` 不含 `example.com` 本身,需要根域就再写一条。
- **M7 不提供**:读写记忆、读邮件、发邮件、发渠道消息、执行任意命令、调用其他工具。需要这些的插件目前做不了;将来开放要单独写 ADR 并过一次评测(它们和「不可信内容进入记忆」「对外发送一律审批」的底线直接相关)。
- 隐含权限(不需要声明):读写自己的 `kv` 与设置、写日志、读取自己的包文件。

### 3.3 设置项

`settings` 是字段数组:`{ key, type: "string" | "number" | "boolean" | "select", label, secret?, required?, default?, options? }`。`secret: true` 的值通过 ADR 0026 的加密存储保存(键为 `plugin.{id}.{key}`),API 永远不回显,只显示「已设置」。原生插件经 `settings.get()` 读自己的值;MCP 插件的环境变量映射写在 `mcp.env`:`{ "API_KEY": { "setting": "apiKey" } }`,启动子进程时由宿主填入。

### 3.4 升级时的权限变化

升级(新版本的清单)与已同意的权限集合比较:**只要新增了任何权限,或 `kind` 变了,就进入 `disabled`,必须用户重新同意**;权限减少或不变可以直接升级。已同意的权限集合与清单哈希一起存库(第 8 节),启动时重新核对,磁盘上的清单被改动则拒绝加载。

### 3.5 各形式的强制程度(安装界面如实展示)

| 保护                    | MCP 插件                 | 原生插件                                    |
| ----------------------- | ------------------------ | ------------------------------------------- |
| 工具调用审批 / 预授权   | 强制                     | 强制                                        |
| 工具输出不可信          | 强制                     | 强制                                        |
| 读不到宿主密钥文件      | **不保证**(用户权限进程) | 强制(第 5.1 节)                             |
| 环境变量不泄露宿主密钥  | 强制(只传设置项)         | 强制                                        |
| 域名范围                | 仅展示,不强制            | 经宿主代发时强制;**直接开 socket 无法阻止** |
| 目录访问                | 仅展示,不强制            | 强制(文件系统由进程权限限制,第 5.1 节)      |
| 条目数量 / 来源命名空间 | —                        | 强制                                        |

「域名范围仅展示」的 MCP 插件在外连清单(ADR 0028)里标为「声明,未强制」,与 stdio MCP 服务器现在的 `local: true` 处理一致。

## 4. 与审批、预授权、net-guard 的关系

- **工具审批(ADR 0010)**:插件工具就是普通工具,按风险级别走第 2 节的默认策略。风险级别 = `max(清单声明, 权限下限)`:
  - 无需任何权限的工具:可声明 `read`;
  - 用到 `fs.write` 或 `net:`:下限 `write`;
  - 工具声明 `sendsData: true`(把用户数据发给第三方):`external`,**不可预授权**;
  - 清单没写级别:`write`(与 ADR 0013 的 MCP 默认一致);`dangerous` 不接受。
- **预授权(ADR 0010 第 3 节,ADR 0039)**:插件工具名 `plugin.{id}.{tool}` 与内置工具共用同一张表和同一条匹配规则;`external` / `dangerous` 仍不能预授权。卸载时按前缀 `plugin.{id}.` 删除并按 `preauth-revoked` 审计。插件不能自己创建预授权。
- **权限不等于预授权**:同意 `net:api.example.com` 只表示这个插件的代码*有资格*访问它,不表示模型调用它的工具时不用审批。反过来,用户预授权了某个工具,也不会让插件获得清单之外的权限。
- **net-guard**:宿主代发的 `net.fetch()` 先过清单授予的域名范围(`matchesDomain`),再过现有的 SSRF 防护(`checkUrl` + 对解析出的每个 IP 调 `isBlockedAddress`,含 fake-IP 开关的行为,#61)。**两者取交集**,任何一个不通过都拒绝。重定向每一跳重新检查;响应体上限沿用 `web.fetch` 的常量。
- **无人值守任务(M6)**:插件工具在任务里与其他工具一样受审批约束(没人批准即拒绝)。任务的「所需工具集合」(ADR 0039 第 4 节)按前缀 `plugin.{id}.` 引用插件工具;集合功能做出来之前,插件工具默认不在无人值守任务的建议集合里。
- **不可信输出(ADR 0016)**:所有插件工具、条目正文的返回值包成 `UntrustedContent`,`source = { kind: 'plugin', ref: 'plugin.{id}.{tool}' }`。`ToolInfo.source`(现为 `builtin` / `mcp`)与 `UntrustedContent.source.kind` 各新增枚举值 `plugin`,属于 ADR 0030 允许的向后兼容增量。条件预授权的失效规则与 MCP 一致。
- **越权调用**(验收「越权调用被拦截」)指:宿主 API 收到清单没授予的权限时返回 `permission_denied` 并写审计;直接调用未启用 / 已卸载插件的工具返回未知工具;插件试图访问授权目录之外的路径、被 net-guard 拦截的地址、未声明的域名。每一类在 PR 里都有对应的测试(🔒,见 `M7-plan.md` 第 10 节)。

## 5. 原生插件的进程隔离

### 5.1 为什么是子进程,不是 worker

`worker_threads` 与宿主共享进程:同一份环境变量、同样的文件系统权限,一个 `process.env` 或 `fs.readFileSync` 就拿到密钥。所以用 `child_process.spawn(process.execPath, [...])` 起独立进程,宿主以**最小权限**启动它:

- 使用 Node 24 的 **Permission Model**(`--permission`):`--allow-fs-read` 只给插件的版本目录(及其 `node_modules`)和宿主提供的运行时入口;`--allow-fs-write` 只给该插件自己的 `data/` 目录;**不给** `--allow-child-process`、`--allow-worker`、`--allow-addons`。数据目录根(`secrets.yaml`、`master.key`、`db.sqlite`、备份)不在任何允许列表里。
- **环境变量白名单**:只传 `PATH`、`TEMP` / `TMPDIR`、`SYSTEMROOT` 等运行所需的少数变量;`FATCAT_AI_*`、`AIP_*`、`FATCAT_MASTER_KEY*` 永不传(沿用 ADR 0013 第 2 节的做法)。
- 资源上限:`--max-old-space-size=64`;消息单条 ≤ 4 MB;请求超时 30 秒;子进程每 10 秒心跳一次并报告自己的 RSS,超过上限的 1.5 倍或连续 3 次丢失心跳则终止。
- 崩溃策略:退出后按退避重启,连续失败 3 次进入 `failed` 并等待用户处理,**不无限重启**。
- 终止:先发优雅关闭消息,5 秒后强杀;Windows 用 `taskkill /T /F` 清理进程树(没有 POSIX 信号)。

### 5.2 诚实地说它防什么、不防什么

- 防:插件读取宿主的密钥文件和数据库、读取宿主的环境变量、启动别的进程、用原生扩展绕过限制、绕过宿主 API 写任意位置。
- **不防**:恶意插件**直接联网**把它自己拿到的数据发出去(Node 的权限模型目前不限制网络),也不防耗尽 CPU。Node 官方也说明权限模型是「防误操作的安全带」,不是对抗恶意代码的安全边界。所以:
  1. 原生插件**默认关闭**,需要用户在设置里打开「允许原生插件」;
  2. 安装界面把原生插件标成比 MCP 更高的风险档,并列出「能直接联网」;
  3. 对不可信代码,文档建议在 Docker 部署里再加容器网络策略(ADR 0031)。
- **闸门**:PR 5 开头先做一个小的实测(Windows / macOS / Linux 上 `--permission` 的行为,包括 `--allow-fs-read` 对 Node 自身运行库的影响)。**如果在 Windows 上不可靠,原生插件在 M7 里不交付,只交付 MCP 插件**,这个降级由业主决定(`M7-plan.md` 问题 3)。

### 5.3 宿主 API(JSON-RPC 2.0,stdio,行分隔)

- 子进程只有一个出口:stdin / stdout 上的 JSON-RPC;stderr 只进日志(截断,不写正文)。协议单独成文档,`pluginApi: 1`。
- 宿主侧每个请求先核对:调用者插件处于 `enabled`、请求的能力在已同意的权限集合内。`net.fetch` 的目标、`fs.*` 的路径由宿主重新规范化与校验,插件说的话不算数。
- 协议违规(非 JSON、超大消息、未知方法洪泛)直接终止子进程并记录原因码。

### 5.4 启动方式

默认**按需启动、空闲 5 分钟退出**:第一次工具调用或条目同步时才起进程,以节省内存;设置里可改为常驻。同时运行的原生插件进程数上限默认 3。

### 5.5 条目提供者的代理

插件的 `registerItemProvider` 在宿主侧由一个 `PluginItemProvider` 适配成 ADR 0012 的 `ItemProvider`:

- `items.source` 固定为 `plugin.{id}`,`type` 必须以 `{id}.` 开头(例如 `video-stats.channel`),不能写入其他提供者的条目,也不能给别人的条目加边;
- 每个插件最多 50,000 条,单条 `meta` ≤ 8 KiB,`summary` ≤ 1,000 字符;
- `open()` 返回的正文受 `MAX_CONTENT_CHARS` 约束并按不可信内容处理;
- 插件进程不可用时,同步报错并保留旧条目(标注来源不可用),不删除。

## 6. 安装来源

统一流程分两步,第一步没有任何副作用:

1. `POST /api/v1/plugins/preview`:下载或读取 → 校验完整性 → 解析清单 → 在 `.staging/{uuid}/` 解出 → 返回 `{ previewId, manifest, permissions, source, integrity, upgradeFrom? }`。
2. `POST /api/v1/plugins/install`:带 `previewId` 与用户同意的**权限集合哈希**(不同意的预览无法安装);原子重命名到 `plugins/{id}/{version}/`。需要登录和 CSRF;TOTP 已启用时是否要求二次验证,以 ADR 0027 已有机制为准,在 PR 2 核对(`M7-plan.md` 问题 8)。

| 来源        | 输入                              | 取得与校验                                                                                                                                                   |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本地目录    | 绝对路径(仅 Web / API 由用户填写) | **复制**到数据目录(不做符号链接,避免安装后源目录被改);拒绝包内符号链接;计算目录的规范化哈希(排序后的路径 + 内容 SHA-256)                                     |
| npm         | 包名 + **精确版本**               | 从 `registry.npmjs.org` 取该版本元数据,下载 tarball,核对 `dist.integrity`(SHA-512),并计算 SHA-256 写入记录;用自己的最小 tar 读取器解出(第 6.1 节)            |
| GitHub 仓库 | `owner/repo` + 标签或提交         | 标签先解析成 **40 位提交哈希**并展示给用户;从 `codeload.github.com` 取该提交的归档,计算 SHA-256;安装记录只存提交哈希。M7 只支持 GitHub,其他 Git 主机以后再说 |
| 市场条目    | 索引里的一项                      | 转成上面三种之一,**另外**核对索引中的校验和与权限摘要(第 7 节)                                                                                               |

### 6.1 解包与「不执行任何东西」

- 宿主不调用 `npm`、`git`、`pip`,**不运行 `postinstall` 等生命周期脚本**。原生插件必须自带依赖(打包成单文件或随包带 `node_modules`);MCP 插件如果需要 Python 等运行时,用户须自己装好解释器,清单里的 `command` 只能是解释器名或包内路径。
- tar 读取器只接受普通文件和目录;拒绝符号链接 / 硬链接 / 设备文件、绝对路径、`..`、Windows 盘符与保留名;限制文件数(≤ 2,000)、单文件(≤ 20 MiB)、总解压体积(≤ 100 MiB)、压缩比(防压缩炸弹),任何超限整体回滚。
- 安装器的网络请求同样走宿主出站:受 net-guard 和 fake-IP 开关约束(用 Clash 一类代理的用户需要打开 #61 的开关,PR 4 的真机测试要覆盖),并列入外连清单(第 7.4 节)。
- 目录:`{dataDir}/plugins/{id}/{version}/`(安装后只读)、`{dataDir}/plugins/{id}/data/`(插件可写)、`{dataDir}/plugins/.staging/`(临时,启动时清空)。升级时保留上一个版本目录一份用于回滚,新版本启动成功后删除更早的版本。

## 7. 市场

### 7.1 索引仓库

一个公开的 GitHub 仓库(建议 `CodingLossy/fatcat-plugins`,由业主创建;`M7-plan.md` 问题 4),内容:

```
plugins/{id}.json      # 每个插件一个文件,作者通过 PR 提交,人工审核
index.json             # 由 CI 从 plugins/*.json 生成,客户端只读它
schema/                # 同一份 zod 生成的 JSON Schema
```

`plugins/{id}.json`:

```json
{
  "indexEntryVersion": 1,
  "id": "video-stats",
  "name": "Video stats",
  "summary": { "en": "…", "zh-CN": "…" },
  "kind": "native",
  "license": "MIT",
  "author": "…",
  "homepage": "https://…",
  "versions": [
    {
      "version": "1.2.0",
      "minCoreVersion": "1.1.0",
      "source": { "type": "github", "repo": "someone/video-stats", "commit": "{40 位十六进制}" },
      "sha256": "{归档字节的 SHA-256,十六进制}",
      "manifestSha256": "{plugin.json 规范化后的 SHA-256}",
      "permissions": ["net:api.example.com", "items.provide"],
      "yanked": false,
      "yankedReason": null,
      "signature": null
    }
  ]
}
```

`source` 也可以是 `{ "type": "npm", "name": "…", "version": "1.2.0" }`;市场条目**不接受本地目录**。

### 7.2 校验和如何起作用

- 客户端下载归档后算 SHA-256,必须等于索引里的 `sha256`;npm 来源另外核对 registry 的 `dist.integrity`。
- 解出清单后核对 `manifestSha256`,并要求清单的 `permissions` **与索引条目一致**(防止索引展示的权限比实际包里的少)。任何不一致:拒绝安装,提示「索引与包内容不符」。
- **索引仓库 CI**(合并前必跑):schema 校验;**重新下载每个新增 / 修改的版本**核对 `sha256` 和 `manifestSha256`;校验清单与条目一致;`id` 唯一且与文件名一致;禁止删除已有版本(下架用 `yanked: true` 并写原因)。
- 被下架(`yanked`)的版本:市场不再展示,已安装的显示警告,不自动卸载。
- 索引本身通过 HTTPS 从仓库默认分支取(`raw.githubusercontent.com`),信任来自 GitHub TLS + 仓库的 PR 审核。**校验和防的是「下载的内容和审核时不是同一个」,不防「审核者批准了恶意插件」**,文档必须这样写。

### 7.3 sigstore(可选)

- `signature` 字段预留:`{ bundleUrl, identity, issuer }`。M7 不要求,也不做签名验证实现:自己实现 sigstore 验证体量大,引入官方 `sigstore` 包会带进很大的依赖树(违背内存预算与「少加依赖」)。
- 推荐路径(可选的后续 PR):若本机 `PATH` 里有 `cosign`,安装预览用 `cosign verify-blob-attestation` / `verify-blob` 校验并显示「签名已验证 / 未验证」;没有 `cosign` 就显示「未验证」。永远不作为安装的必要条件。桌面安装包的发布已经使用 cosign(计划 M10),工具链一致。

### 7.4 隐私、零遥测与外连清单

- 取索引**只在用户打开市场页或点击「检查更新」时发生**,没有后台轮询,不带任何标识,不上报安装数据。
- 设置里可关闭市场(此时只能从本地目录 / npm / GitHub 手动安装)。
- 外连清单(ADR 0028)新增 `plugin` 类目条目:索引地址、`registry.npmjs.org`、`codeload.github.com`,以及每个已启用插件声明的 `net:` 域名(原生:「已强制」;MCP:「声明,未强制」)。`scripts/check-egress.mjs` 的登记表同步更新,运行时一致性测试覆盖。

## 8. 数据库(迁移)

沿用 ADR 0005:迁移前自动备份;只**新增表**,旧版本二进制忽略这些表,因此可以回退到升级前的备份而不丢旧功能。外键开启(`PRAGMA foreign_keys = ON`)。

### 迁移 0018(PR 2)

```
plugins(
  id                 TEXT PRIMARY KEY,          -- 内部 id
  owner_id           TEXT NOT NULL,             -- 1.0 单用户,预留
  plugin_id          TEXT NOT NULL,             -- 清单里的 id
  version            TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('mcp','native')),
  state              TEXT NOT NULL CHECK (state IN ('installed','enabled','disabled','failed','removing')),
  source_type        TEXT NOT NULL CHECK (source_type IN ('local','npm','github','market')),
  source_ref         TEXT NOT NULL,             -- 路径 / 包名@版本 / repo@提交;展示用
  archive_sha256     TEXT NOT NULL,
  manifest_sha256    TEXT NOT NULL,
  manifest_json      TEXT NOT NULL,
  granted_json       TEXT NOT NULL,             -- 用户同意的权限集合(排序后的数组)
  granted_at         TEXT NOT NULL,
  previous_version   TEXT,                      -- 用于回滚
  last_error_code    TEXT,
  installed_at       TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (owner_id, plugin_id)
)
plugin_settings(
  plugin_row_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_json    TEXT,                           -- secret 项为 NULL,值在加密存储里
  PRIMARY KEY (plugin_row_id, key)
)
```

### 迁移 0019(PR 5,原生运行时)

```
plugin_kv(
  plugin_row_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,                  -- 插件总量 ≤ 1 MiB,由仓储层检查
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (plugin_row_id, key)
)
```

不另建表的部分:条目用 `items.source = 'plugin.{id}'`;预授权用现有表按前缀删除;审计用现有审计表(若审计的 `kind` 有 CHECK 约束,则同一迁移放宽并补迁移测试);插件的 secret 项存在 ADR 0026 的加密存储里(键 `plugin.{id}.{key}`);市场索引缓存是 `{dataDir}/plugins/.cache/index.json`,不入库。

两个迁移各自在对应 PR 里提交,**描述第一行写「含数据库迁移」**,附迁移前后测试和回滚说明,由业主确认后合并(沿用 M6 的做法)。

## 9. 卸载

按固定顺序执行,**幂等、可重试**;状态先置为 `removing`(重启后若发现 `removing` 就继续做完)。

1. 停用:拒绝新调用,优雅关闭子进程(超时强杀 / Windows 杀进程树),等待退出。
2. 注销:工具、条目提供者、设置页、任务模板从内存中移除。
3. **一个数据库事务**里删除:该插件的条目与相关边(`items.source = 'plugin.{id}'`,并重算父级计数)、`plugin_settings`、`plugin_kv`(级联)、前缀为 `plugin.{id}.` 的预授权(写 `preauth-revoked` 审计)、`plugins` 行。
4. 引用了该插件工具的定时任务:**不删除**,置为停用并写入原因 `plugin_removed`,用户在任务页能看到。
5. 删除加密存储里的 `plugin.{id}.*` 密钥。
6. 删除文件:`plugins/{id}/` 整个目录(含 `data/`)。用户可在卸载确认框里勾选「保留插件数据」,此时只删代码目录与数据库行,`data/` 移到 `plugins/.kept/{id}-{时间戳}/`,并在设置里可见、可手动清除。
7. 审计只追加一条 `plugin-uninstalled`(审计本身不随卸载删除)。

文件被占用(Windows 上常见)导致步骤 6 失败:状态保持 `removing`,启动时和用户点「重试」时再删,界面显示原因。

**验收方法**:自动化测试对每种形式(本地 / npm / 市场的 MCP 插件、原生插件)做「快照 → 安装 → 使用(含写条目、写 kv、建预授权)→ 卸载 → 快照」,断言数据库相关表行数相等、数据目录文件树相等(不保留数据的情况下)。

## 10. API(`/api/v1/plugins`,PR 2 起随实现提交 OpenAPI)

| 端点                                 | 说明                                             |
| ------------------------------------ | ------------------------------------------------ |
| `GET /plugins`                       | 已安装列表(状态、版本、权限、进程内存、最近错误) |
| `GET /plugins/{id}`                  | 详情                                             |
| `POST /plugins/preview`              | 第 6 节第 1 步                                   |
| `POST /plugins/install`              | 第 6 节第 2 步(升级也走它,带 `previewId`)        |
| `PATCH /plugins/{id}`                | 启用 / 停用                                      |
| `PUT /plugins/{id}/settings`         | 保存设置(secret 项只写不读)                      |
| `DELETE /plugins/{id}?keepData=bool` | 卸载                                             |
| `GET /plugins/market`                | 取索引(用户触发,带搜索过滤)                      |
| `POST /plugins/{id}/rollback`        | 回到 `previous_version`                          |

全部需要登录,修改类需要 CSRF;全是新增路径,不触及 ADR 0030 的冻结范围。

## 11. 内存预算(ADR 0018)

- **没有插件时空闲不变**:插件管理器与 MCP 客户端一样按需 `import()`;`GET /plugins` 只读数据库。CI 的空闲 RSS 门禁(≤ 250 MiB、相对基线 +10% 警告 / +20% 失败)原样适用,PR 2 需要贴出前后实测。
- **宿主侧增量**:每个运行中的插件在宿主进程里的增量(RPC 缓冲、状态)要测量并写进 ADR 0018 的新一条规则,上限暂定每个插件 ≤ 3 MiB、全部插件 ≤ 15 MiB(与渠道增量的做法一致,第 5 节),由 PR 5 实测后确认。
- **插件进程单独计算**:原生插件子进程不计入 250 MiB。它们的预算:每个进程 `--max-old-space-size=64`(RSS 预期 50–90 MiB);最多 3 个并发(可调);按需启动、空闲退出。心跳里的 RSS 显示在插件页上。MCP 插件的子进程宿主不测量(与 ADR 0013 一致),界面注明。
- 2 GB 部署(M6 的假设):250 MiB(宿主)+ 3 × ~90 MiB(原生插件)+ MCP 进程,仍留出余量;文档写明「插件越多越吃内存」。

## 12. 范围外与推迟

- 渠道插件(`channel.provide`)、插件读写记忆 / 邮件、插件调用其他工具、插件向 Web UI 注入界面;
- sigstore 验证实现(预留字段;可选的 `cosign` 路径作为后续 PR);
- 其他 Git 主机、npm 私有源与认证、依赖自动安装;
- 插件自动更新(M7 只有手动「检查更新」);
- 多用户下的插件隔离(2.0,表已有 `owner_id`)。

## 后果

- 清单、权限和流水线一次定清,后面 8 个 PR 各自小而完整;迁移只有两个且只增表。
- 诚实标注了隔离的边界:MCP 插件不受宿主文件 / 网络约束,原生插件不能阻止直接联网。市场审核和用户同意是第二道防线,不是可有可无的装饰。
- 宿主不跑包管理器带来的代价:原生插件作者必须打包依赖,Python MCP 插件用户要自己装运行时。这是有意换来的安全。
- Node 权限模型是外部依赖,行为可能随 Node 版本变化;PR 5 的实测闸门和 CI 里的隔离用例(读 `secrets.yaml` 必须失败)用来发现这种变化。

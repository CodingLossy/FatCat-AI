# ADR 0040 · 插件与插件市场

- 状态:提议(M7 设计主稿,业主确认后合并)。第 12 节记录业主 2026-11-17 已做的决定;另一份设计稿 #63 不再继续,其中被采纳的内容已并入本 ADR(各处注明)。
- 日期:2026-11-17
- 相关:开发计划第 9 节 M7、第 15.5 节(SDK 许可);ADR 0010(工具与审批)、ADR 0011(本地文件)、ADR 0013(MCP 客户端)、ADR 0016(不可信内容)、ADR 0026(密钥加密)、ADR 0028(外连清单)、ADR 0030(`/api/v1` 冻结)、ADR 0033(定时任务)、ADR 0039(预授权域名)
- 范围:本 ADR 只定设计,不含实现代码与迁移文件。实现按第 11 节拆成 9 个 PR。

## 背景

开发计划 M7 原写法有两种插件:① MCP Server(任意语言);② 原生 TS 插件(在 worker 或子进程里跑 `@fatcat-ai/plugin-sdk` 的受限 API)。安装来源写了 npm、Git、本地目录与市场。

现状:

- ADR 0013 已有自写的 stdio MCP 客户端(`packages/tools/src/mcp/`,按需 `import()`),配置存在 `mcp_servers`(迁移 0004),**命令和参数由用户手填,子进程与服务器同权限运行**,能读数据目录里的一切(含 `secrets.yaml`、`master.key`)。这对「用户自己配的进程」可以接受,对「从市场一键装的别人的代码」不行。
- `packages/plugin-sdk` 只有占位入口。
- 审批(`approval_requests`、`tool_preauth`、`audit_log`,迁移 0002)、预授权域名(ADR 0039 `matchesDomain` / `parseDomainScope`)、SSRF 防护(`packages/tools/src/builtin/net-guard.ts`,含 fake-IP 开关,#61)都已就绪,插件接到这些现有机制上,不另起一套。
- 最新迁移是 0017,下一个是 **0018**。

## 1. 插件形态:只有一种协议,MCP 优先

**决定:插件 = 一个带 `plugin.json` 的包,入口是一个用 stdio 说 MCP 的进程。** 原生 TS 插件不再是另一种运行方式,而是「用 `@fatcat-ai/plugin-sdk` 写的 MCP Server,另外用到了 FatCat 的扩展方法」。

| 层          | 内容                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准 MCP    | `initialize`、`tools/list`、`tools/call`。任何符合 MCP 的 JS 服务器打包成插件后即可工作,不需要 SDK。                                                                                                                                                                          |
| FatCat 扩展 | 同一条 stdio 连接上、名字以 `fatcat/` 开头的 JSON-RPC 方法(MCP 允许自定义方法)。方向一:主程序调插件(`fatcat/items.roots`、`fatcat/items.children`、`fatcat/items.open`)。方向二:插件请求主程序(`fatcat/net.fetch`、`fatcat/items.upsert`、`fatcat/log`、`fatcat/heartbeat`)。 |
| SDK         | `@fatcat-ai/plugin-sdk`(Apache-2.0,依赖 `@fatcat-ai/shared`):`definePlugin()`、`registerTool()`、`registerItemProvider()`、`ctx.fetch()`、`ctx.log()`;内部自带一个最小 stdio MCP 服务端(与 ADR 0013 一样自写,不引入 `@modelcontextprotocol/sdk`)。                            |

**为什么这样选:**

1. **一套隔离、一套审批**:两种运行方式就要两套隔离和两套越权用例。都走子进程 + MCP 后,第 4 节的隔离和第 3 节的权限检查只写一次。
2. **复用现有客户端**:ADR 0013 的客户端已经处理了消息上限、超时、进程退出与不可信输出包装;只需把它对「服务器发来的请求」一律回「方法不存在」的地方,改成按授权路由 `fatcat/*`。
3. **生态**:不依赖 SDK 的普通 MCP 服务器也能上架;SDK 只是让写 FatCat 专属能力(知识地图条目、受控网络)更方便。
4. **worker 不够隔离**:同进程的 worker 共享文件系统权限,做不到第 4 节「读不到 `master.key`」,所以不用 worker。

**许可(业主已定)**:插件与核心之间**通过进程边界加公开协议调用;SDK 用 Apache-2.0,插件作者自选许可**。市场索引注明每个插件的许可证(开发计划第 15.5 节)。SDK 在示例插件跑通(第 11 节 PR 6)之后再发布 `0.x` 到 npm。

**M7 的插件入口只能是 JavaScript**(`.js` / `.mjs`,由主程序自带的 Node 运行)。第 4 节的文件隔离靠 Node 权限模型;Python 或二进制的 MCP 服务器没有跨平台、零依赖的同等隔离手段,继续走 ADR 0013 的「手动 MCP 服务器」,界面上标注「未隔离,与服务器同权限」。

**ADR 0013 的手动 MCP 服务器保持不变**,与插件并存:手动服务器是用户自己负责的进程;插件是带清单、经过隔离和授权的包。工具名前缀不同(`mcp.<server>.` 与 `plugin.<id>.`)。

不在 M7:插件注册渠道、插件提供 Web UI 脚本、插件调用其他插件、Streamable HTTP 传输、付费插件(第 10 节)。

## 2. `plugin.json` 清单

放在包根目录,UTF-8,上限 64 KiB。schema 在 `packages/shared/src/plugin.ts`(Apache-2.0,PR 1 定),宿主、SDK 的校验命令与索引仓库 CI 共用同一份。未知字段一律拒绝(`strictObject`),只有 `x-` 开头的字段忽略。

| 字段              | 必填 | 说明                                                                                                                            |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | 是   | 固定 `1`。以后不兼容的变化用 `2`                                                                                                |
| `id`              | 是   | `^[a-z][a-z0-9-]{1,31}$`,全局唯一(市场按 id 去重),安装后不可改;工具名、数据目录、预授权都依赖它                                 |
| `version`         | 是   | semver `MAJOR.MINOR.PATCH`,可带 `-pre` 后缀;不支持 `+build`                                                                     |
| `name`            | 是   | i18n 文案:`{ "zh-CN": "...", "en": "..." }`,至少一种语言,每项 ≤ 64 字符                                                         |
| `description`     | 是   | 同上,每项 ≤ 500 字符                                                                                                            |
| `author`          | 是   | 字符串 ≤ 128 字符                                                                                                               |
| `license`         | 是   | SPDX 表达式                                                                                                                     |
| `homepage`        | 否   | `https://` URL                                                                                                                  |
| `engines.fatcat`  | 是   | 兼容的核心版本:`>=1.1.0` 或 `>=1.1.0 <2.0.0` 两种写法(自写约 30 行解析,不引入 semver 依赖)                                      |
| `entry`           | 是   | `{ "type": "mcp-stdio", "main": "dist/server.js" }`;`main` 是包内相对路径,只能是 `.js` / `.mjs`,不能含 `..`                     |
| `permissions`     | 是   | 见下表;没有写的能力一律没有                                                                                                     |
| `settings`        | 否   | 设置项的 JSON Schema 子集(只允许 `string` / `number` / `boolean` / `enum`,最多 20 项),Web 按 schema 渲染表单,插件的脚本不进 Web |
| `taskTemplates`   | 否   | 定时任务模板(ADR 0033 的任务草稿格式),最多 10 个;只是模板,用户确认后才建任务,仍走任务确认卡,模板不能带预授权                    |
| `licensing`       | 否   | 变现预留,见第 10 节;M7 只接受 `{ "model": "free" }`                                                                             |

`permissions`:

| 键        | 形式                                                                                                                | 说明                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tools`   | `[{ "name": "forecast", "risk": "read" \| "write" \| "external", "sendsData"?: boolean, "constraint"?: "domain" }]` | 允许注册的工具与风险级别,最多 50 个;`tools/list` 返回的未声明工具不注册;`dangerous` 不接受 |
| `net`     | `["api.open-meteo.com", "*.example.org"]`                                                                           | 经 `fatcat/net.fetch` 可访问的域名,写法与校验同 ADR 0039(`broad` 拒绝),最多 20 条          |
| `secrets` | `[{ "name": "WEATHER_API_KEY", "required": false, "description": { ... } }]`                                        | 需要的密钥名,`^[A-Z][A-Z0-9_]{0,63}$`,不得以 `FATCAT_AI_` / `AIP_` 开头,最多 8 个          |
| `items`   | `{ "categories": [{ "type": "video", "title": { ... } }] }`                                                         | 可注册的知识地图顶层类别(开发计划第 6.2 节 `registerItemProvider`),配额见第 3.3 节         |

`sendsData: true` 表示这个工具会把用户的数据(参数、对话内容、条目)发到外部服务,例如「把这段文字发到某个笔记服务」。市场审核会核对有 `net` 权限的插件的每个工具是否如实标注。

M7 没有、因此一律拒绝的能力:读写用户文件夹(ADR 0011 的授权目录)、启动子进程、worker、原生扩展(addon)、WASI、注册渠道、读其他插件的数据。

示例:

```json
{
  "manifestVersion": 1,
  "id": "weather",
  "version": "1.2.0",
  "name": { "zh-CN": "天气", "en": "Weather" },
  "description": { "zh-CN": "查询城市天气预报", "en": "City weather forecasts" },
  "author": "Example Author",
  "license": "MIT",
  "homepage": "https://example.org/weather-plugin",
  "engines": { "fatcat": ">=1.1.0 <2.0.0" },
  "entry": { "type": "mcp-stdio", "main": "dist/server.js" },
  "permissions": {
    "tools": [{ "name": "forecast", "risk": "read" }],
    "net": ["api.open-meteo.com"],
    "secrets": [
      {
        "name": "WEATHER_API_KEY",
        "required": false,
        "description": { "zh-CN": "可选,付费档的密钥", "en": "Optional key for the paid tier" }
      }
    ]
  },
  "settings": {
    "type": "object",
    "properties": { "unit": { "type": "string", "enum": ["c", "f"], "default": "c" } }
  },
  "taskTemplates": [
    {
      "title": { "zh-CN": "每天早上推送天气", "en": "Morning weather" },
      "prompt": "查一下今天的天气,推送给我",
      "trigger": { "kind": "cron", "expression": "0 7 * * *" }
    }
  ],
  "licensing": { "model": "free" }
}
```

**PR 1 实现注记**(契约以 `packages/shared/src/plugin.ts` 为准,与上文有出入处在此说明):

- `taskTemplates[].trigger` 沿用 ADR 0033 的 `TaskTrigger`(cron 的字段是 `expression`,上面示例原写 `expr`,已改正),模板里只接受 `cron` 与不带账户的 `mail_received`:`once` 需要绝对时刻,`file_changed` 需要用户环境里的目录 id,都不适合做模板。
- `fatcat/items.children` 与 `fatcat/items.open` 的参数多带一个 `type`(节点所属的类别),宿主据此找到对应的提供者。
- `settings` 的 `string` 项可带 `enum`(即上表「enum」);`taskTemplates[].title` 与类别 `title` 一样是 i18n 文案。
- `compareSemver` 按 semver 规则比较预发布标识;核心版本是预发布(如 `1.1.0-rc.1`)时不满足 `>=1.1.0`。
- 示例插件放在 `examples/plugins/hello`,按 Apache-2.0 发布(与 SDK 一致,方便复制);仓库内它直接引用工作区里的 SDK,发布前需要先打包成单个 JS 文件。

## 3. 权限模型

### 3.1 安装时一次授权

- 安装(及增加权限的升级,第 6 节)前,界面完整列出清单里的权限:每个工具与级别、每个域名、每个密钥名、知识地图类别;并列出第 3.5 节的「保护程度」表。
- **全部同意才能安装,不能只勾一部分**(部分授权会让插件以作者没测过的方式失败)。密钥的绑定可以留空,`required: true` 的密钥未绑定时插件不能启用。
- 同意的内容存进 `plugins.granted_json`(第 7 节),是运行时判定的唯一依据;磁盘上的清单被改动不影响已授权的范围,且启动前会校验包的 sha256(第 5.4 节)。

### 3.2 工具调用接入现有审批

- 声明的工具以 `plugin.<id>.<tool>` 注册进现有 `ToolRegistry`,与内置工具、MCP 工具走同一个 `decide()`。审批写 `approval_requests`,`tool_name` 带前缀,审批卡显示插件名与「来自插件」。
- **实际风险级别 = max(清单声明, 下限)**,下限规则:
  - `sendsData: true` → `external`,**不可预授权**(ADR 0010:`external` 每次都要审批)。并入自 #63。
  - 插件有 `net` 权限 → 下限 `write`(仍可预授权)。理由:能联网的插件,参数里的对话内容可以被带出去。
  - 其余 → 照声明;清单没写级别按 `write`(与 ADR 0013 一致)。
- 工具结果按 ADR 0013 第 5 节包成不可信内容,`source = { kind: 'plugin', ref: 'plugin.<id>.<tool>' }`;`ToolInfo.source` 与 `UntrustedContent.source.kind` 各增加枚举值 `plugin`(ADR 0030 允许的增量);`untrustedOutput: true`,执行后本次运行的条件预授权失效。
- 预授权:`write` 可整体预授权;声明了 `"constraint": "domain"` 的工具可以按 ADR 0039 的规则带域名约束(约束参数名固定为 `url`,用 `matchesDomain` 比较)。定时任务的预授权白名单与「任务工具集」(ADR 0039 第 4 节)写 `plugin.<id>.<tool>` 或前缀 `plugin.<id>.`。插件不能自己创建预授权。
- **权限不等于预授权**:同意 `net` 只表示插件的代码有资格访问那些域名,不表示模型调用它的工具时免审批;反过来,预授权某个工具也不给插件清单之外的权限。
- 执行时核对调用者 `ownerId` 与插件所属 owner 一致(同 ADR 0013 第 4 节)。

### 3.3 插件发起的请求:默认拒绝

主程序只响应下表里的 `fatcat/*` 方法;表外的方法(包括 MCP 的 `sampling`、`elicitation`)回「方法不存在」。每次判定只看 `granted_json`。

| 方法                  | 需要的授权            | 主程序做什么                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fatcat/net.fetch`    | `net` 中有匹配的域名  | 只允许 `https:`;先 `matchesDomain`,再过现有 SSRF 防护(`checkUrl` + 对解析出的每个 IP 调 `isBlockedAddress`,含 fake-IP 开关的行为),**两者取交集**;重定向每一跳重新检查;超时 30 秒、响应体上限沿用 `web.fetch`;不带 Cookie,不转发主程序的任何凭据;请求头黑名单(`Host`、`Cookie`、`Proxy-*`) |
| `fatcat/items.upsert` | `items` 中有该 `type` | 写入的条目 `source` 固定为 `plugin:<id>`,只能挂在本插件注册的类别下;每次最多 500 条;**每个插件最多 50,000 条,单条 `meta` ≤ 8 KiB**(并入自 #63),超出返回 `quota_exceeded`                                                                                                                  |
| `fatcat/log`          | 无(总是允许)          | 写主程序日志,字段 `plugin=<id>`,每分钟最多 60 条,超出丢弃;单条截断到 1,000 字符                                                                                                                                                                                                           |
| `fatcat/heartbeat`    | 无(总是允许)          | 插件每 30 秒自报一次 `rss`(SDK 自动发送);只用于第 8 节的显示和 Windows 上的阈值判断                                                                                                                                                                                                       |

- 被拒绝的调用返回 JSON-RPC 错误 `permission_denied`,写一条 `plugin_events`(`kind = 'denied'`,只存方法名与原因,不存参数正文)。同一插件 1 分钟内被拒超过 20 次时停用插件并提示用户。
- 密钥不经 RPC 取,见第 4.3 节;没有 `fatcat/secrets.get` 这类方法。
- `net.fetch` 的目的地登记到外连清单(ADR 0028,类别 `plugin`,每个授权域名一项)。

### 3.4 插件直接联网怎么办(多层防护,业主已定)

Node 24 的权限模型管文件、子进程、worker、addon、WASI,**不管网络**。所以「声明了 `net` 才能联网」在 M7 由多层共同保证,不是一道硬墙:

1. **运行时预加载**(`--import` 主程序自带的预加载脚本,在插件代码之前运行):删除全局 `fetch`、`WebSocket`、`EventSource`;用同步模块钩子(`module.registerHooks`,同时覆盖 ESM `import`、CJS `require` 以及 `module.createRequire` 得到的 `require`)拒绝 `node:net`、`node:tls`、`node:http`、`node:https`、`node:http2`、`node:dgram`、`node:dns`、`node:child_process`、`node:worker_threads`、`node:cluster`、`node:inspector`、`node:vm`、`node:repl`、`node:sqlite`;`process.binding` 与 `process.dlopen` 置为抛错(后者另有权限模型不给 `--allow-addons` 兜底)。SDK 的 `ctx.fetch` 走 `fatcat/net.fetch`。
2. **市场审核**:索引仓库的 CI 对包做静态检查(打包产物里不得出现上述模块名、`process.binding`、`process.dlopen`,以及 `eval` / `new Function` 动态拼接这些名字),人工审核 PR(第 5.2 节)。
3. **将来的硬隔离**:Node 的网络权限进入 LTS 后,运行时检测到就启用,第 1 层变为后备。

越权用例对上面每个模块名、`import` / `require` / `createRequire` 三种加载方式、`process.binding`、`process.dlopen` 各写一条;**`node:sqlite` 这类不涉及网络、但能绕开文件限制的内置模块,在权限模型下能否被拦住要在三个平台实测**(第 11 节 PR 2b 的第一步),拦不住的进入第 1 层的拒绝名单。安装界面对「本地目录、未签名」的插件额外显示「未经市场审核」。

### 3.5 每项保护在当前平台做到什么程度(安装界面如实显示,并入自 #63)

安装确认页与插件详情页显示下表,「当前平台」一列由主程序在运行时按自己所在的平台和 Node 版本填写(例如 Windows 上「内存阈值」一行显示「由插件自报」)。表的内容来自 PR 2b 的平台实测;实测不通过而降级的项,写降级后的真实程度。

| 保护                       | 做到的程度                                                      |
| -------------------------- | --------------------------------------------------------------- |
| 工具调用审批 / 预授权      | 强制                                                            |
| 工具输出按不可信内容处理   | 强制                                                            |
| 读不到主程序的密钥与数据库 | 强制(Node 权限模型;以 PR 2b 的平台实测为准)                     |
| 环境变量不泄露主程序密钥   | 强制(不继承环境,第 4.2 节)                                      |
| 经主程序代发的网络请求     | 强制(域名范围 + SSRF 防护)                                      |
| 插件自己直接联网           | **只能多层防护,不能保证**(第 3.4 节)                            |
| 知识地图条目数量与命名空间 | 强制                                                            |
| 内存阈值                   | Linux / macOS:主程序测量;Windows:插件自报(第 8 节);默认不设阈值 |
| 市场审核与签名             | 市场安装:已验证签名的索引 + 审核;本地目录:无                    |

## 4. 进程隔离

### 4.1 启动方式

每个启用的插件一个子进程:

```
<process.execPath>
  --permission
  --allow-fs-read=<插件代码目录>,<插件数据目录>,<预加载脚本>
  --allow-fs-write=<插件数据目录>
  [--max-old-space-size=<MiB>]          # 仅当用户为这个插件设置了 V8 堆上限
  [--max-semi-space-size=<MiB>]         # 同上,可选
  --import=<预加载脚本>
  <插件代码目录>/<entry.main>
```

- 不给 `--allow-child-process`、`--allow-worker`、`--allow-addons`、`--allow-wasi`。
- **V8 堆参数是单插件的可选设置,默认不传**(不限)。
- `spawn` 用 `shell: false`,stdio 三条管道,其余文件描述符不继承;`cwd` 为插件数据目录;子进程优先级调低一档(`os.setPriority`,Windows 同样有效),对话优先。
- 目录:代码在 `<数据目录>/plugins/<id>/<version>/`(只读),数据在 `<数据目录>/plugin-data/<id>/`(读写)。两者都不在 `secrets.yaml`、`secrets.yaml.enc`、`master.key`、`db.sqlite`、`backups/`、`logs/` 的路径之下,权限模型拒绝读取这些文件。
- Node 权限模型的已知限制:**符号链接会被跟随到允许范围之外**。对策:安装时拒绝包含符号链接或硬链接的包(第 5.4 节);每次启动前检查插件数据目录,发现符号链接、junction 或其他重解析点就拒绝启动并提示用户。Windows 上的路径变体(junction、8.3 短名、UNC、大小写不同)由 PR 2b 实测(第 11 节)。
- **停止插件**(空闲停止、用户手动「停止」、停用、服务器关闭):先关闭子进程的 stdin(MCP stdio 约定的关闭方式),等 5 秒;仍未退出时 Linux / macOS 发 `SIGTERM` 再等 2 秒后 `SIGKILL`,Windows 直接 `kill()`(Windows 上 `kill()` 就是立即结束进程,没有「先通知再等待」的效果,优雅退出只靠关闭 stdin)。
- **空闲停止**:插件在第一次被调用(工具调用、知识地图展开)时启动,空闲 10 分钟后按上面的方式停止。**不限制同时运行的插件数量。**
- **手动停止**:插件页每个运行中的插件有「停止」按钮;停止后下一次调用会重新启动。要彻底不运行用「停用」。
- **崩溃**:非正常退出时工具注销;**5 分钟内崩溃 3 次就停用**(状态 `error`,写 `plugin_events(kind='crashed')`),不再自动拉起,用户手动启用即可重试。

### 4.2 环境变量

子进程的环境**不继承**主程序的环境,只有:`PATH`、`SYSTEMROOT` / `WINDIR`(Windows 运行所需)、`LANG`、`TZ`(用户时区,ADR 0023)、`HOME` 与 `TMPDIR` / `TEMP` / `TMP`(都指向插件数据目录下的 `home/`、`tmp/`)、`FATCAT_PLUGIN_ID`、`FATCAT_PLUGIN_DATA`,以及第 4.3 节绑定的密钥。`NODE_OPTIONS`、`NODE_PATH` 一律不传。`FATCAT_AI_*` / `AIP_*` 永远不传。

### 4.3 密钥:只用 `env:` 引用,经启动环境传入(业主已定)

- 清单声明密钥**名字**;用户在插件设置里把每个名字绑定到一个 `env:<变量名>` 引用(只接受 `env:`,不接受 `file:`,也不接受明文值)。数据库只存 `{ "WEATHER_API_KEY": "env:MY_WEATHER_KEY" }`。
- 启动子进程时,主程序从**自己的**进程环境读出 `MY_WEATHER_KEY` 的值,以声明的名字 `WEATHER_API_KEY` 放进子进程环境。这就是受控通道:值只在启动那一刻经操作系统的进程环境传递,不经 RPC、不落盘、不进日志。主程序记录启动失败或崩溃时只写插件 id、退出码与 stderr 末尾,**不记录 spawn 的参数与环境**;stderr 末尾在写入日志与 `plugin_events` 前按已绑定的密钥值做替换脱敏。PR 2b 加测试:插件启动失败、崩溃、把密钥打印到 stderr 三种情况下,日志与 `plugin_events` 中都不出现密钥值。
- 主程序环境里没有对应变量时:`required` 的密钥让启动失败(状态 `error`,提示缺哪个变量名);可选的不传。改绑定后重启插件生效。卸载时绑定随插件行删除,环境变量本身不动。
- 不支持 `file:`(即 `secrets.yaml`)的理由:让插件密钥与模型、渠道密钥分开,插件出问题时影响面只是部署者为它单独设的那几个环境变量。**M10 桌面端再接系统钥匙串**,届时另写 ADR。

## 5. 安装来源

M7 只有两种来源:**本地目录**与**市场**。不支持 npm 与 Git(业主已定):`npm install` 会执行依赖的生命周期脚本,Git 仓库需要构建步骤,两者都在授权之前执行了别人的代码。插件必须以「已打包好、带全部依赖」的形式分发,安装过程不运行插件的任何代码。

### 5.1 本地目录

- 入口:CLI `fatcat plugins install --from <绝对路径>` 与 API(`POST /plugins/prepare`,`source: { kind: 'local', path }`)。Web 上同样可以填路径(只有登录的主人能用,路径是服务器所在机器上的路径)。
- 目录被**复制**进 `plugins/<id>/<version>/`,不在原处运行;复制时执行第 5.4 节的全部检查。记录内容的 sha256。
- 界面标「本地 · 未签名 · 未经市场审核」。

### 5.2 市场

- **官方索引仓库 `CodingLossy/fatcat-plugins`**(业主已定,由业主创建)。作者通过 PR 上架,维护者人工审核后合并。合并后由维护者**在本机**运行签名脚本,发布 `index.json` 与 `index.json.sig`(GitHub Pages 或仓库 Release)。
- **索引仓库 CI**(合并前必跑,并入自 #63):清单与条目的 schema 校验;**重新下载每个新增 / 修改的版本,核对 `sha256`**,并核对包内 `plugin.json` 的权限与条目一致;第 3.4 节的静态检查;`id` 唯一;**不许删除已有版本**,下架只能标 `yanked: true` 并写 `yankedReason`。CI 不接触签名私钥。
- **客户端配置**:`config.yaml` 的 `plugins.markets`,默认只有官方一项:`{ id: 'official', indexUrl }`,官方公钥内置在主程序里。用户自己加的市场只能写在 `config.yaml`(必须同时写公钥,Web 不能加),默认没有。
- **关闭市场开关**(并入自 #63):设置里「插件市场」可关闭;关闭后不下载索引、市场页隐藏、外连清单里不出现市场地址,本地目录安装不受影响。
- **索引格式**(`index.json`,上限 4 MiB):

```json
{
  "formatVersion": 1,
  "market": "official",
  "serial": 42,
  "generatedAt": "2026-12-01T08:00:00Z",
  "expiresAt": "2027-01-01T08:00:00Z",
  "downloadHosts": ["github.com", "objects.githubusercontent.com"],
  "plugins": [
    {
      "id": "weather",
      "name": { "zh-CN": "天气", "en": "Weather" },
      "description": { "zh-CN": "查询城市天气预报", "en": "City weather forecasts" },
      "author": "Example Author",
      "license": "MIT",
      "homepage": "https://example.org/weather-plugin",
      "versions": [
        {
          "version": "1.2.0",
          "engines": { "fatcat": ">=1.1.0 <2.0.0" },
          "url": "https://github.com/example/weather-plugin/releases/download/v1.2.0/weather-1.2.0.tgz",
          "size": 182344,
          "sha256": "<64 位十六进制>",
          "permissions": { "tools": [{ "name": "forecast", "risk": "read" }], "net": ["api.open-meteo.com"] },
          "publishedAt": "2026-11-30T12:00:00Z",
          "yanked": false,
          "yankedReason": null
        }
      ],
      "licensing": { "model": "free" }
    }
  ]
}
```

- **签名**:`index.json.sig` 是对 `index.json` 原始字节的 Ed25519 签名(base64,带 `keyId`),用 `node:crypto` 验证,不引入依赖。包的 sha256 写在已签名的索引里,所以验证了索引就间接验证了每个包。**校验和与签名防的是「下载的内容与审核时不是同一个」,不防「审核者批准了恶意插件」**,文档照此写明。作者级签名(sigstore 等)不做,版本条目预留可选字段 `signatures`,M7 忽略。
- **密钥(业主已定)**:生成**两对** Ed25519 密钥,主用与备用,**两个公钥都内置进程序**,任何一个签的都接受;主用私钥泄露或丢失时改用备用,并在下一个版本里换掉泄露的公钥。两份私钥由业主离线保管(各自再有一份离线备份),**绝不放进 GitHub Secrets 或任何 CI**;签名脚本(`scripts/plugins/sign-index.mjs`,PR 4)在业主本机运行,只从本地文件读私钥。
- **防回滚与防过期**:客户端缓存上一次验证通过的索引;新索引的 `serial` 必须大于等于缓存的;**`expiresAt` 已过的索引不采用**(维护者至少每月重签一次,有效期默认 30 天),防止被长期替换成一份旧的、签名仍然有效的索引。
- **浏览与搜索**:在客户端对缓存的索引过滤,不做服务端搜索。索引只在用户打开市场页或点「刷新」时下载,不定时拉取(零遥测:只发一个 GET,不带任何标识)。
- 索引里每个插件的 `permissions` 只用于列表展示;**授权以包内 `plugin.json` 为准**,两者不一致时拒绝安装(`plugin_manifest_mismatch`)。
- **被下架的版本**:市场不再展示;已安装的版本被 `yanked` 时,插件页显示警告与 `yankedReason`,不自动卸载或停用。

### 5.3 下载与失败处理

| 情况                                       | 处理                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 索引下载失败(网络、超时 30 秒、非 200)     | 继续用缓存的索引(未过期时),界面显示「索引更新失败,显示的是 <时间> 的版本」;没有可用缓存则市场页显示错误与重试按钮    |
| 索引签名无效 / 未知 `keyId` / 格式错误     | **不采用**,保留缓存;写 `plugin_events(kind='market-rejected')`;界面显示「索引签名无效,已忽略」                       |
| 索引 `serial` 小于缓存,或 `expiresAt` 已过 | 同上(疑似回滚或过期);缓存本身过期时市场页只显示错误,不能安装                                                         |
| 包下载失败                                 | 删除暂存文件,不改动已安装的任何东西;错误码 `plugin_download_failed`;不自动重试,用户点重试                            |
| 包超过 `size` 或 50 MiB 上限               | 中止下载,同上,`plugin_too_large`                                                                                     |
| sha256 不符                                | 删除暂存文件,`plugin_checksum_mismatch`,写 `plugin_events(kind='checksum-mismatch')`,界面红字提示,不提供「仍然安装」 |
| 解包检查失败(第 5.4 节)                    | 删除暂存目录,`plugin_package_invalid` 并附具体原因                                                                   |

- 安装器的所有请求(索引与包)走主程序的出站检查:只允许 `https:`;包的主机必须在索引的 `downloadHosts` 中(每一跳重定向都检查,最多 5 跳);解析地址过 net-guard,**受 fake-IP 开关约束**(#61;用 Clash 一类代理的用户需要打开开关,PR 4 的真机测试覆盖)。并入自 #63。
- 市场 `indexUrl` 的主机与 `downloadHosts` 登记到外连清单(ADR 0028,类别 `plugin`)。
- 暂存在 `<数据目录>/plugins/.staging/<随机名>/`;启动时清理 24 小时前的暂存目录。

### 5.4 解包与包检查(两种来源共用)

- 包格式 `.tgz`(ustar + gzip)。用 `node:zlib` 解压,**自写最小 tar 读取器**(约 150 行),只接受普通文件与目录条目;遇到以下任何一项整体拒绝:符号链接、硬链接、设备文件、绝对路径、含 `..` 的路径、重复路径、**Windows 盘符(`C:`)或驱动器相对路径**、**Windows 保留文件名**(`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`,含带扩展名的形式与末尾的点或空格)、仅大小写不同的重复路径。本地目录复制时同样拒绝符号链接、junction 与硬链接(`nlink > 1`)。
- 上限:解压后总大小 200 MiB、文件数 5,000、单个文件 50 MiB、路径长度 240 字符(Windows 兼容);**压缩比**:解压字节数超过已读压缩字节数的 100 倍即中止(防压缩炸弹),边解边算,不等全部解完。并入自 #63。
- 包根必须有 `plugin.json`,schema 校验通过,`entry.main` 存在;`engines.fatcat` 不满足当前核心版本时拒绝(`plugin_incompatible`)。
- 安装完成后对代码目录计算一次「目录 sha256」(按路径排序的文件路径 + 内容哈希,复用 `apps/server/src/data-dir.ts` 已有的目录哈希写法),存进 `plugins.content_sha256`;每次启动前重算比较,不符则拒绝启动(状态 `error`,提示「插件文件被改动」)。

## 6. 卸载与升级

### 6.1 卸载

卸载对话框有一个勾选项「同时删除插件数据」,**默认不勾**;对话框写明「插件数据不在自动备份里,删除后无法恢复」。

| 对象                                           | 不勾(默认)                                                    | 勾选                   |
| ---------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| 子进程                                         | 停止                                                          | 停止                   |
| `plugin.<id>.*` 工具注册                       | 注销                                                          | 注销                   |
| `tool_preauth` 中 `plugin.<id>.` 开头的条目    | 删除,按 `preauth-revoked` 审计(同 ADR 0013)                   | 同左                   |
| `pending` 的 `approval_requests`               | 标为 `cancelled`                                              | 同左                   |
| 引用该插件的定时任务                           | **停用**,`disabled_reason = 'plugin_removed'`,任务页显示原因  | 同左                   |
| 代码目录 `plugins/<id>/`                       | 删除                                                          | 删除                   |
| 知识地图里 `source = 'plugin:<id>'` 的条目与边 | 删除(内容在插件里,留着打不开)                                 | 删除                   |
| `plugins` 行                                   | 保留,`state = 'uninstalled'`(设置值与密钥绑定留着,重装时沿用) | 删除                   |
| 数据目录 `plugin-data/<id>/`                   | 保留                                                          | 删除                   |
| `plugin_events`、`audit_log`                   | 保留                                                          | 保留(审计不随卸载删除) |

- **引用该插件的任务**指:任务的工具集或预授权白名单含 `plugin.<id>.` 开头的名字,或任务由该插件的模板创建(任务 `policy` 里记 `fromPlugin`)。卸载前对话框列出这些任务;卸载时把它们停用(`enabled = 0`)并写 `disabled_reason = 'plugin_removed'`(迁移 0018 新增的列,第 7 节),任务页显示「插件已卸载」,用户重新启用时清空原因。并入自 #63。
- 卸载是幂等的:中途失败(比如 Windows 上文件被占用)时状态为 `uninstalling`,下次启动继续完成。
- **卸载验收**(并入自 #63):安装前与「勾选删除数据」的卸载后,对数据目录的文件树(路径与大小)和数据库每张表的行数各拍一次快照,两者一致;`plugin_events` 与 `audit_log` 的新增行、预授权撤销的审计行除外。「不勾」的卸载,差异只能是 `plugin-data/<id>/`、`state = 'uninstalled'` 的 `plugins` 行和被停用任务的两列。
- 自动备份只包含数据库;`plugin-data/` 不在自动备份里,文档与卸载对话框都写明。

### 6.2 升级

1. 下载 / 复制新版本到暂存目录,做第 5.3、5.4 节的全部检查。
2. **权限对比**:新清单的权限不超出已授权范围时直接继续;有任何新增(新工具、工具级别升高、新增 `sendsData`、新域名、新密钥、新类别)时进入 `upgrade-pending`,界面列出差异,用户同意后才继续,期间旧版本照常运行。权限减少不需要同意。
3. **备份插件数据**:把 `plugin-data/<id>/` 复制到 `plugin-data/.backup/<id>/<旧版本>/`(超过 500 MiB 时不复制,提示「升级失败将无法自动恢复数据」并要求再次确认)。
4. 新版本放进 `plugins/<id>/<新版本>/`;停止旧进程;用新版本启动,**健康检查**:30 秒内完成 MCP 握手、`tools/list` 成功且声明的工具都在。
5. 成功:`plugins` 行更新 `version`、`previous_version`、`granted_json`、`content_sha256`;保留上一个版本的代码目录与数据备份各一份(更早的删除),插件页可「回退到上一版本」。
6. **失败回滚**:停止新进程 → 用备份恢复 `plugin-data/<id>/` → 用旧版本启动 → 删除新版本目录 → 写 `plugin_events(kind='upgrade-failed')` 并在界面显示原因。数据库里的 `plugins` 行在第 5 步之前不改,所以回滚只涉及文件。
7. 核心升级后某插件的 `engines.fatcat` 不再满足:状态 `incompatible`,不启动,提示升级插件;不自动卸载。

## 7. 数据库设计(迁移 0018)

迁移 0018 新增两张表,并给 `tasks` 加一个可为空的列,不改其他已有表。**迁移单独一个小 PR(第 11 节 PR 2a),业主确认后才合并**;迁移前按 ADR 0005 自动备份。

```sql
CREATE TABLE plugins (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plugin_id        TEXT NOT NULL,              -- 清单 id
  version          TEXT NOT NULL,
  previous_version TEXT,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('local','market')),
  source_ref       TEXT NOT NULL,              -- 本地路径或 '<market>:<id>@<version>'
  signed_key_id    TEXT,                       -- 验证索引用的公钥 id;本地安装为 NULL
  content_sha256   TEXT NOT NULL,
  manifest_json    TEXT NOT NULL,              -- 安装时校验通过的清单
  granted_json     TEXT NOT NULL,              -- 用户同意的权限(第 3.1 节)
  secret_refs_json TEXT NOT NULL DEFAULT '{}', -- { 名字: 'env:变量名' },不存值
  settings_json    TEXT NOT NULL DEFAULT '{}', -- 插件设置值,以及 V8 堆上限、内存阈值这类单插件运行设置
  state            TEXT NOT NULL CHECK (state IN
                   ('enabled','disabled','error','incompatible','upgrade-pending','uninstalling','uninstalled')),
  error            TEXT,
  installed_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_id, plugin_id)
);

-- 插件事件:安装、升级、卸载、越权拒绝、校验失败。卸载后保留,所以不加外键。
CREATE TABLE plugin_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  plugin_id  TEXT NOT NULL,
  version    TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('installed','upgraded','upgrade-failed','uninstalled','enabled',
             'disabled','stopped','denied','checksum-mismatch','market-rejected','crashed','memory-threshold')),
  detail     TEXT                                -- 短文本:方法名、错误码;不存参数与正文
);
CREATE INDEX idx_plugin_events_owner_at ON plugin_events(owner_id, at, id);

-- 卸载插件时停用引用它的任务并写明原因(第 6.1 节)
ALTER TABLE tasks ADD COLUMN disabled_reason TEXT;
```

- **为什么新建 `plugin_events` 而不扩展 `audit_log`**:`audit_log.action` 有 CHECK 约束,SQLite 改 CHECK 要重建整张表。插件工具的**调用**照常写 `audit_log(action='tool-call')`;生命周期事件进新表。设置页「审计」页把两张表按时间合并显示。
- `disabled_reason` 目前只有 `plugin_removed` 一个值,不加 CHECK(以后其他停用原因直接复用这一列);`tasks` API 增加可选只读字段 `disabledReason`(ADR 0030 允许的增量)。
- `plugin_events` 保留 180 天,由现有每日维护任务清理(与 `audit_log` 的保留策略一致)。
- `ownerId` 照常预留(1.0 单用户)。
- 回滚说明:迁移只新增表和一个可为空的列。旧版本**不能**直接打开已迁移到 18 的库(`migrate()` 会报 `database has migration 18 (plugins) unknown to this version` 并拒绝启动)。唯一的回退办法:停掉服务,用 `backups/` 里的 `db-…-pre-0018.sqlite` 恢复,再运行旧版本。代价:备份之后写入的数据(新对话、任务记录等)会丢失。
- 不入库的:市场索引缓存(`plugins/.market/<market>.json` 与 `.sig`)、插件进程状态与内存读数(只在内存,同 ADR 0013 第 3 节)。

## 8. 内存:只测量和报告,不拦截(业主 2026-11-17 决定)

业主决定内存按实际需要使用,本 ADR 不设插件的内存预算、总数上限或总内存上限。

- **主程序**:插件管理代码与 MCP 客户端一样按需 `import()`,没有启用任何插件时不加载。
- **插件进程**:
  - **默认不限**。V8 堆上限(`--max-old-space-size` / `--max-semi-space-size`)和「内存阈值」都是**单插件的可选设置**,在插件页设置,存在 `plugins.settings_json` 里,默认都不设。
  - 设了阈值时:Linux 每 30 秒读 `/proc/<pid>/status` 的 `VmRSS`,macOS 用 `ps -o rss=`;**Windows 用插件的 `fatcat/heartbeat` 自报的 RSS**(SDK 每 30 秒自动发送;不用 SDK 的插件在 Windows 上没有读数,界面显示「无读数」)。连续两次超过阈值则按第 4.1 节停止插件,写 `plugin_events(kind='memory-threshold')` 并提示用户。自报的数字由插件提供,不可信,只用于用户自己设的阈值与显示。
  - 插件页显示每个运行中插件最近一次的 RSS 读数。
  - 保留:空闲 10 分钟停止(第 4.1 节)、手动「停止」、5 分钟内崩溃 3 次停用。
- **每个 PR 都测量并记录,只报告、不拦截**:涉及插件运行时的 PR(第 11 节 PR 2b 起)在 PR 描述里写:主程序在「无插件」与「启用示例插件」两种情况下的空闲 RSS、示例插件进程的空闲 RSS、连续 100 次工具调用后两者的 RSS。用 `scripts/perf/plugin.mjs`(`pnpm perf:plugin`)测量,结果只打印,CI 里不作为门禁。
- ADR 0018、CI 内存门禁、`.github/memory-baseline.json`、README 和 Docker 文档中关于 2 GB 服务器与 250 MiB 的表述,已由 ADR 0041 及其 PR 改为只测量、不设门禁。

## 9. API 与界面(`/api/v1` 增量,不破坏 ADR 0030 冻结的部分)

| 端点                                                  | 说明                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plugins`                                        | 已安装列表,含状态、版本、授权、来源、最近一次 RSS 读数、是否被下架                                                                                               |
| `POST /plugins/prepare`                               | `source: { kind: 'local', path } \| { kind: 'market', market, id, version }`;下载 / 复制并检查,返回 `stagingId`、清单、权限(升级时含差异)、第 3.5 节的保护程度表 |
| `POST /plugins/install`                               | `{ stagingId, accept: true }`;完成安装或升级                                                                                                                     |
| `PATCH /plugins/{id}`                                 | `enabled`、`secretRefs`、`settings`(含 V8 堆上限与内存阈值)                                                                                                      |
| `POST /plugins/{id}/stop`                             | 手动停止运行中的插件(第 4.1 节)                                                                                                                                  |
| `POST /plugins/{id}/rollback`                         | 回退到上一版本(走第 6.2 节第 4–6 步)                                                                                                                             |
| `DELETE /plugins/{id}?purgeData=`                     | 卸载                                                                                                                                                             |
| `GET /plugins/market`、`POST /plugins/market/refresh` | 缓存的索引与刷新;市场关闭时返回 `market_disabled`                                                                                                                |
| `GET /plugins/{id}/events`                            | 该插件的事件                                                                                                                                                     |

全部需要登录,修改类需要 CSRF;**没有对应的 Agent 工具**,模型不能安装、升级、启用或改授权(同 ADR 0013 第 2 节)。Web 新增「插件」页:已安装、市场、安装确认(权限清单与保护程度表)、设置(按 `settings` schema 渲染的表单、密钥绑定、可选的内存设置)、停止 / 停用、卸载对话框。设置页加「插件市场」开关。插件的任何文本按纯文本显示。

## 10. 变现预留(M7 只支持免费插件;付费另写 ADR,业主已定)

只定扩展点,让以后加付费插件时不需要改清单版本、索引格式或表结构的含义:

1. **清单 `licensing`**:`{ "model": "free" | "paid" | "trial", "vendor"?: string, "verifyKeyId"?: string }`。M7 只接受 `free`,其他值安装时拒绝(`plugin_licensing_unsupported`),这样旧核心不会错误地运行付费插件。
2. **索引 `licensing`**:与清单同形,以后加 `price`、`purchaseUrl`;M7 客户端只显示 `free` 的插件。
3. **授权校验钩子**:插件状态机在「启动进程」之前有一步 `LicenseCheck.verify(plugin) → ok | { denied, reason }`,M7 的实现恒为 `ok`。以后优先用**离线可验证的授权文件**(厂商 Ed25519 签名,存 `plugin-data/<id>/license`),不在启动时联网,保持零遥测;需要联网激活的方案必须登记外连清单并由用户主动触发。
4. **授权交给插件**:以后通过启动环境传一个 `FATCAT_PLUGIN_LICENSE` 路径(只读),与密钥同一条受控通道。
5. **商业边界**:付费插件是第三方独立作品,核心的 AGPL / 商业双许可不受影响;官方市场收录付费插件的规则另写 ADR。

## 11. 实现 PR 拆分

按 CLAUDE.md:同一时间只开一个功能 PR;每个 PR 做完整(后端、前端、测试、文档一起);含迁移的 PR 由业主确认后合并。**「任务工具集声明」(ADR 0039 第 4 节)排在最前面**,是独立的小 PR,不混进下列任何一个。

| #   | 分支                       | 范围                                                                                                                                                                                                                                                                                                                            | 验收标准                                                                                                                                                                                                                                                                                                                                               | 自测                                                                                 | 风险 / 真机                                                                                                               |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 0   | `feat/task-tool-set`       | 任务工具集声明(ADR 0039 第 4 节)                                                                                                                                                                                                                                                                                                | 见 ADR 0039                                                                                                                                                                                                                                                                                                                                            | 见该 PR                                                                              | 中;无迁移                                                                                                                 |
| 1   | `feat/plugin-manifest`     | `packages/shared/src/plugin.ts`(清单、索引、`fatcat/*` 消息的 zod schema);`engines` 版本范围解析;`packages/plugin-sdk`(`definePlugin`、`registerTool`、`registerItemProvider`、`ctx.fetch`、`ctx.log`、心跳、自带 stdio MCP 服务端);`examples/plugins/hello`                                                                    | 清单 schema 拒绝未知字段、越界值、`broad` 域名、`FATCAT_AI_` 密钥名、`dangerous` 工具、非 `free` 的 `licensing`;示例插件能被 ADR 0013 的客户端当普通 MCP 服务器连接并调用;SDK 包许可证头为 Apache-2.0;SDK 暂不发布到 npm                                                                                                                               | `pnpm lint`、`typecheck`、`check:spdx`、`check:licenses`;shared 与 plugin-sdk 的单测 | 低;无迁移;不需要真机                                                                                                      |
| 2a  | `feat/plugin-migration`    | **迁移 0018**(第 7 节)与对应的 storage 仓储和单测;不接入运行时                                                                                                                                                                                                                                                                  | 迁移前自动备份;空库与带数据的旧库都能迁移;回退到迁移前备份可正常启动                                                                                                                                                                                                                                                                                   | storage 包单测(迁移前后)                                                             | **高(迁移)**;**业主确认后才合并**;不需要真机                                                                              |
| 2b  | `feat/plugin-runtime`      | **第一步:在 Windows、Linux、macOS 实测 Node 权限模型**(见下);插件管理器(按需加载)、第 4 节的启动方式与预加载、环境与密钥绑定、空闲停止、手动停止、崩溃停用、可选的堆参数与内存阈值、心跳、`fatcat/log` 路由、工具注册与第 3.2 节的级别规则;本地目录安装、启用 / 停用、卸载(含任务停用)的服务端逻辑与 API;外连清单;`perf:plugin` | 本地目录安装示例插件后可在对话中调用(经审批);卸载快照验收(第 6.1 节);越权用例全部被拦:读 `master.key` / `secrets.yaml.enc` / `db.sqlite`、读其他插件数据目录、数据目录里的符号链接或 junction、启动子进程、第 3.4 节的每个模块与加载方式、全局 `fetch`、未声明工具、未授权的 `fatcat/*` 方法、`FATCAT_AI_*` 环境变量;日志与 `plugin_events` 不含密钥值 | 受影响包的单测与集成测试;`pnpm perf:plugin` 的结果写进 PR 描述(只报告)               | **高(安全)**;需业主在 **Windows 真机**上跑平台实测脚本并确认结果;macOS 实测(业主有条件时)                                 |
| 2c  | `feat/plugin-ui`           | Web 插件页(已安装、本地安装确认与保护程度表、设置表单、密钥绑定、内存设置与读数、停止 / 停用、卸载对话框与备份提示)、任务页显示 `plugin_removed`;CLI `plugins install/list/stop/remove`                                                                                                                                         | 全部界面在浏览器里点过;卸载对话框列出受影响任务;CLI 与 Web 的结果一致                                                                                                                                                                                                                                                                                  | 受影响包的单测;每个改动的界面至少一张截图                                            | 低;不需要真机                                                                                                             |
| 3   | `feat/plugin-capabilities` | `fatcat/net.fetch`(域名匹配、net-guard、fake-IP、重定向、大小与超时)、`items` 提供者(`roots/children/open`、`items.upsert`、配额、卸载清理)、`settings` 表单、`taskTemplates`(从模板建任务草稿,走确认卡)、`sendsData` 级别规则;示例插件补上这些能力                                                                             | 未授权域名、私网地址、重定向到私网、超大响应、超配额条目、超大 `meta` 都被拒并写 `denied` 事件;插件条目出现在知识地图浏览器且能打开;卸载后条目消失;模板建任务必须经确认卡;`sendsData` 工具不能预授权                                                                                                                                                   | 单测 + 越权用例;Web 截图(设置表单、知识地图里的插件类别、模板建任务)                 | 高(网络与安全);无迁移;不需要真机                                                                                          |
| 4   | `feat/plugin-market`       | 市场配置、两把内置公钥与关闭开关;索引下载、Ed25519 验签、`serial` 防回滚、`expiresAt`、缓存;包下载(`downloadHosts`、重定向检查、net-guard 与 fake-IP、大小上限)、sha256;第 5.4 节的 tar 读取器;`yanked` 警告;Web 市场页;外连清单;`scripts/plugins/`(索引 CI 检查脚本、本机签名脚本)                                             | 用测试密钥签的本地假索引能浏览并安装;主用与备用公钥签的索引都接受;签名错误、未知 `keyId`、`serial` 回退、过期索引、sha256 不符、符号链接 / `..` / 盘符 / 保留名 / 超限 / 压缩炸弹包、`downloadHosts` 之外的重定向都被拒且已安装的东西不变;下载中断后暂存目录被清理;市场关闭后不发任何请求                                                              | 单测(假 HTTP 服务器,不联网);Web 截图                                                 | 高(网络、供应链);无迁移;需业主:建索引仓库、在本机生成两对签名密钥;**真机**:开 Clash 类代理时打开 fake-IP 开关后能正常下载 |
| 5   | `feat/plugin-upgrade`      | 第 6.2 节升级流程:权限差异与再次同意、数据备份、健康检查、失败回滚、手动回退、`incompatible` 状态                                                                                                                                                                                                                               | 无新增权限时直接升级;新增权限时旧版本继续运行直到同意;健康检查失败时数据与旧版本完整恢复;回退后可再次升级                                                                                                                                                                                                                                              | 单测 + 用故意坏掉的示例版本做回滚集成测试;Web 截图(权限差异、失败提示)               | 高(数据回滚);无迁移;**Windows 真机**:升级时文件占用与目录替换                                                             |
| 6   | `docs/m7-wrapup`           | M7 自检(`docs/milestones/M7-self-check.md`);插件开发指南(中英,英文标注待校对)、CHANGELOG;把一个第三方 JS MCP 服务器打包成插件、一个 SDK 插件上架到官方索引;SDK 发布 `0.x`                                                                                                                                                       | 从市场一键安装一个打包的 MCP 插件和一个 SDK 插件;卸载干净(快照一致);越权调用被拦截                                                                                                                                                                                                                                                                     | 按自检清单                                                                           | 中;需业主在 Windows 真机与 Linux 服务器上各装卸一次,记录内存读数                                                          |

**PR 2b 的第一步:权限模型平台实测**(并入自 #63)。先写一个独立的实测脚本,在 Windows、Linux、macOS 上以第 4.1 节的参数启动一个探测插件,逐项尝试越界访问,输出通过 / 不通过表。用例至少包括:

- 直接读 `master.key`、`secrets.yaml.enc`、`db.sqlite`、其他插件的数据目录;
- 数据目录里的符号链接、**junction / 重解析点**指向上述文件;
- **8.3 短名**(如 `C:\Users\THEODO~1\.fatcat-ai\master.key`)、**UNC 路径**(`\\?\C:\...`、`\\localhost\C$\...`)、**大小写不同的路径**;
- **数据目录路径含中文或空格**;
- 第 3.4 节的每个内置模块(含 `node:sqlite`)在 `import`、`require`、`createRequire` 下的拦截。

全部通过才继续实现。**任何一项不通过就降级**:例如在该平台上把「读不到主程序的密钥与数据库」降为「不保证」、把数据目录移到权限模型能可靠拦截的位置、或在该平台只允许安装市场审核过的插件;降级方案连同实测结果写进 PR 描述**报给业主决定**,决定前不合并。第 3.5 节的保护程度表以实测结果为准。

## 12. 业主已定的问题(2026-11-17)

| #   | 问题                     | 决定                                                                                                    |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | 设计主稿                 | 本 ADR(#64);#63 不再继续,其中采纳的内容已并入                                                           |
| 2   | 索引仓库                 | `CodingLossy/fatcat-plugins`,由业主创建                                                                 |
| 3   | 签名私钥                 | 两对 Ed25519 密钥(主用 + 备用),公钥都内置;私钥由业主离线保管两份,不进 GitHub Secrets;签名脚本在本机运行 |
| 4   | 安装来源                 | 只有本地目录与市场;不支持 npm、Git                                                                      |
| 5   | 联网限制                 | 定位为多层防护(第 3.4 节),不承诺硬隔离                                                                  |
| 6   | 付费插件                 | M7 只支持免费插件;付费另写 ADR                                                                          |
| 7   | 插件密钥                 | 本期只用 `env:` 引用;M10 再接系统钥匙串                                                                 |
| 8   | 原生插件许可措辞         | 通过进程边界加公开协议调用,SDK 用 Apache-2.0,插件作者自选许可                                           |
| 9   | SDK 发布                 | 示例插件跑通后再发布 `0.x`                                                                              |
| 10  | 内存                     | 完全放开:不设预算、总数或总内存上限;只测量、报告,不拦截(第 8 节)                                        |
| 11  | 非 JS 插件               | 按推荐:M7 不上架,继续用 ADR 0013 手动配置并标注「未隔离」                                               |
| 12  | 卸载时插件数据           | 按推荐:默认保留,勾选才删除                                                                              |
| 13  | 生命周期事件             | 按推荐:新表 `plugin_events`,不扩展 `audit_log`                                                          |
| 14  | 能联网插件的 `read` 工具 | 按推荐:按 `write` 审批(可预授权);`sendsData` 的工具为 `external`,不可预授权                             |
| 15  | 第三方市场               | 按推荐:只能在 `config.yaml` 里加,必须写公钥;默认没有                                                    |

仍需业主操作或确认的:迁移 PR(2a)合并前确认;PR 2b 的 Windows 实测与任何降级方案;PR 4 前建索引仓库并在本机生成两对密钥。

## 后果

- 插件只有一种运行方式(子进程 + MCP),隔离与权限检查只实现一次;ADR 0013 的客户端增加 `fatcat/*` 路由,手动 MCP 服务器行为不变。
- 主程序在没有插件时不加载插件代码;插件进程的内存不设上限,只测量与报告,用户可以为单个插件设阈值。
- 新增两张表和 `tasks.disabled_reason` 一列(迁移 0018)。
- 不新增运行时依赖:Ed25519、gzip 用 `node:crypto` / `node:zlib`,tar 读取器与版本范围解析自写。
- 已知限制:插件直接联网只能多层防护(第 3.4 节);Windows 上的内存读数由插件自报、不可信,不用 SDK 的插件没有读数;Windows 上停止插件没有 `SIGTERM` 那样的通知,只能靠关闭 stdin;权限模型在各平台的实际效果以 PR 2b 实测为准;M7 不支持非 JS 插件、插件渠道、插件 UI 脚本、付费插件。

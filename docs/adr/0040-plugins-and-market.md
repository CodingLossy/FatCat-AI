# ADR 0040 · 插件与插件市场

- 状态:提议(M7 设计 PR,业主确认后合并;第 12 节的问题每条都有推荐,不回复就按推荐做,例外见该节末尾)
- 日期:2026-11-17
- 相关:开发计划第 9 节 M7、第 12 节(资源预算)、第 15.5 节(SDK 许可);ADR 0010(工具与审批)、ADR 0011(本地文件)、ADR 0013(MCP 客户端)、ADR 0016(不可信内容)、ADR 0018(内存预算)、ADR 0026(密钥加密)、ADR 0028(外连清单)、ADR 0030(`/api/v1` 冻结)、ADR 0039(预授权域名)
- 范围:本 ADR 只定设计,不含实现代码与迁移文件。实现按第 11 节拆成 6 个 PR。

## 背景

开发计划 M7 原写法有两种插件:① MCP Server(任意语言);② 原生 TS 插件(在 worker 或子进程里跑 `@fatcat-ai/plugin-sdk` 的受限 API)。安装来源写了 npm、Git、本地目录与市场。

现状:

- ADR 0013 已有自写的 stdio MCP 客户端(`packages/tools/src/mcp/`,按需 `import()`),配置存在 `mcp_servers`(迁移 0004),**命令和参数由用户手填,子进程与服务器同权限运行**,能读数据目录里的一切(含 `secrets.yaml`、`master.key`)。这对「用户自己配的进程」可以接受,对「从市场一键装的别人的代码」不行。
- `packages/plugin-sdk` 只有占位入口。
- 审批(`approval_requests`、`tool_preauth`、`audit_log`,迁移 0002)、预授权域名(ADR 0039 `matchesDomain` / `parseDomainScope`)、SSRF 防护(`packages/tools/src/builtin/net-guard.ts`)都已就绪,插件应接到这些现有机制上,而不是另起一套。
- 最新迁移是 0017,下一个是 **0018**。

## 1. 插件形态:只有一种协议,MCP 优先

**决定:插件 = 一个带 `plugin.json` 的包,入口是一个用 stdio 说 MCP 的进程。** 原生 TS 插件不再是另一种运行方式,而是「用 `@fatcat-ai/plugin-sdk` 写的 MCP Server,另外用到了 FatCat 的扩展方法」。

| 层          | 内容                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准 MCP    | `initialize`、`tools/list`、`tools/call`。任何符合 MCP 的 JS 服务器打包成插件后即可工作,不需要 SDK。                                                                                                                                                      |
| FatCat 扩展 | 同一条 stdio 连接上、名字以 `fatcat/` 开头的 JSON-RPC 方法(MCP 允许自定义方法)。方向一:主程序调插件(`fatcat/items.roots`、`fatcat/items.children`、`fatcat/items.open`)。方向二:插件请求主程序(`fatcat/net.fetch`、`fatcat/items.upsert`、`fatcat/log`)。 |
| SDK         | `@fatcat-ai/plugin-sdk`(Apache-2.0,依赖 `@fatcat-ai/shared`):`definePlugin()`、`registerTool()`、`registerItemProvider()`、`ctx.fetch()`、`ctx.log()`;内部自带一个最小 stdio MCP 服务端(与 ADR 0013 一样自写,不引入 `@modelcontextprotocol/sdk`)。        |

**为什么这样选:**

1. **一套隔离、一套审批**:两种运行方式就要两套隔离和两套越权用例。都走子进程 + MCP 后,第 4 节的隔离和第 3 节的权限检查只写一次。
2. **复用现有客户端**:ADR 0013 的客户端已经处理了消息上限、超时、进程退出与不可信输出包装;只需把它对「服务器发来的请求」一律回「方法不存在」的地方,改成按授权路由 `fatcat/*`。
3. **生态**:不依赖 SDK 的普通 MCP 服务器也能上架;SDK 只是让写 FatCat 专属能力(知识地图条目、受控网络)更方便。
4. **许可**:插件经 stdio 与核心通信,按开发计划第 15.5 节视为独立作品;SDK 为 Apache-2.0,插件作者不被 AGPL 传染。
5. **worker 不够隔离**:同进程的 worker 共享文件系统权限和进程内存上限,做不到第 4 节「读不到 `master.key`」,所以不用 worker。

**M7 的插件入口只能是 JavaScript**(`.js` / `.mjs`,由主程序自带的 Node 运行)。原因是第 4 节的文件隔离靠 Node 权限模型;Python 或二进制的 MCP 服务器没有跨平台、零依赖的同等隔离手段,继续走 ADR 0013 的「手动 MCP 服务器」,界面上标注「未隔离,与服务器同权限」。(问题 1)

**ADR 0013 的手动 MCP 服务器保持不变**,与插件并存:手动服务器是用户自己负责的进程;插件是带清单、经过隔离和授权的包。两者的工具名前缀不同(`mcp.<server>.` 与 `plugin.<id>.`)。

不在 M7:插件注册渠道(渠道涉及收发外部消息,先不开放)、插件提供 Web UI 脚本、插件调用其他插件、Streamable HTTP 传输。

## 2. `plugin.json` 清单

放在包根目录,UTF-8,上限 64 KiB。schema 在 `packages/shared/src/plugin.ts`(Apache-2.0,PR 1 定),未知字段一律拒绝(`strictObject`),只有 `x-` 开头的字段忽略。

| 字段              | 必填 | 说明                                                                                                                            |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | 是   | 固定 `1`。以后不兼容的变化用 `2`,核心同时认识的版本写在发布说明里                                                               |
| `id`              | 是   | `^[a-z][a-z0-9-]{1,31}$`,全局唯一(市场按 id 去重),安装后不可改;工具名、数据目录、预授权都依赖它                                 |
| `version`         | 是   | semver `MAJOR.MINOR.PATCH`,可带 `-pre` 后缀;不支持 `+build`                                                                     |
| `name`            | 是   | i18n 文案:`{ "zh-CN": "...", "en": "..." }`,至少一种语言,每项 ≤ 64 字符                                                         |
| `description`     | 是   | 同上,每项 ≤ 500 字符                                                                                                            |
| `author`          | 是   | 字符串 ≤ 128 字符                                                                                                               |
| `license`         | 是   | SPDX 表达式;市场索引同样展示(开发计划第 15.5 节)                                                                                |
| `homepage`        | 否   | `https://` URL                                                                                                                  |
| `engines.fatcat`  | 是   | 兼容的核心版本:`>=1.1.0` 或 `>=1.1.0 <2.0.0` 两种写法(自写约 30 行解析,不引入 semver 依赖)                                      |
| `entry`           | 是   | `{ "type": "mcp-stdio", "main": "dist/server.js" }`;`main` 是包内相对路径,只能是 `.js` / `.mjs`,不能含 `..`                     |
| `permissions`     | 是   | 见下表;没有写的能力一律没有                                                                                                     |
| `settings`        | 否   | 设置项的 JSON Schema 子集(只允许 `string` / `number` / `boolean` / `enum`,最多 20 项),Web 按 schema 渲染表单,插件的脚本不进 Web |
| `taskTemplates`   | 否   | 定时任务模板(ADR 0033 的任务草稿格式),最多 10 个;只是模板,用户确认后才建任务,仍走任务确认卡                                     |
| `licensing`       | 否   | 变现预留,见第 10 节;M7 只校验格式,`model` 只接受 `free`                                                                         |

`permissions`:

| 键        | 形式                                                                                                        | 说明                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tools`   | `[{ "name": "forecast", "risk": "read" \| "write" \| "external" \| "dangerous", "constraint"?: "domain" }]` | 允许注册的工具与风险级别,最多 50 个;`tools/list` 返回的未声明工具不注册           |
| `net`     | `["api.open-meteo.com", "*.example.org"]`                                                                   | 经 `fatcat/net.fetch` 可访问的域名,写法与校验同 ADR 0039(`broad` 拒绝),最多 20 条 |
| `secrets` | `[{ "name": "WEATHER_API_KEY", "required": false, "description": { ... } }]`                                | 需要的密钥名,`^[A-Z][A-Z0-9_]{0,63}$`,不得以 `FATCAT_AI_` / `AIP_` 开头,最多 8 个 |
| `items`   | `{ "categories": [{ "type": "video", "title": { ... } }] }`                                                 | 可注册的知识地图顶层类别(开发计划第 6.2 节 `registerItemProvider`)                |

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
      "trigger": { "kind": "cron", "expr": "0 7 * * *" }
    }
  ]
}
```

## 3. 权限模型

### 3.1 安装时一次授权

- 安装(及增加权限的升级,第 6 节)前,界面完整列出清单里的权限:每个工具与级别、每个域名、每个密钥名、知识地图类别;另外固定显示「运行在独立进程,只能读写自己的数据目录」。
- **全部同意才能安装,不能只勾一部分**(部分授权会让插件以作者没测过的方式失败)。密钥的绑定可以留空,`required: true` 的密钥未绑定时插件不能启用。
- 同意的内容存进 `plugins.granted_json`(第 7 节),是运行时判定的唯一依据;清单文件本身被改动(本地目录安装后有人改了文件)不影响已授权的范围,且启动前会校验包的 sha256(第 5.4 节)。

### 3.2 工具调用接入现有审批

- 声明的工具以 `plugin.<id>.<tool>` 注册进现有 `ToolRegistry`,与内置工具、MCP 工具走同一个 `decide()`:`read` 自动执行,`write` 需审批且可预授权,`external` / `dangerous` 不可预授权,`dangerous` 默认禁用(ADR 0010)。审批写 `approval_requests`,`tool_name` 带前缀,审批卡显示插件名与「来自插件」。
- **有 `net` 权限的插件,其 `read` 工具按 `write` 处理**(仍可预授权)。理由:能联网的插件,参数里的对话内容可以被带出去,这正是审批要拦的东西。没有 `net` 的插件,`read` 照声明执行。(问题 8)
- 工具结果按 ADR 0013 第 5 节包成不可信内容,`source = { kind: 'plugin', ref: 'plugin.<id>.<tool>' }`;`untrustedOutput: true`,执行后本次运行的条件预授权失效。
- 预授权:整体预授权与 ADR 0010 相同;声明了 `"constraint": "domain"` 的工具,可以按 ADR 0039 的域名规则带约束预授权(约束参数名固定为 `url`,用 `matchesDomain` 比较)。定时任务的预授权白名单(ADR 0039)写 `plugin.<id>.<tool>` 或前缀 `plugin.<id>.`。
- 执行时核对调用者 `ownerId` 与插件所属 owner 一致(同 ADR 0013 第 4 节)。

### 3.3 插件发起的请求:默认拒绝

主程序只响应下表里的 `fatcat/*` 方法;表外的方法(包括 MCP 的 `sampling`、`elicitation`)回「方法不存在」。每次判定都只看 `granted_json`。

| 方法                  | 需要的授权            | 主程序做什么                                                                                                                                                                                                                              |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fatcat/net.fetch`    | `net` 中有匹配的域名  | 只允许 `https:`;`matchesDomain` 比较主机名;解析后的地址经 `net-guard` 检查(私网、回环、元数据地址一律拒绝);重定向每一跳重新检查;超时 30 秒、响应体上限 4 MiB;不带 Cookie,不转发主程序的任何凭据;请求头黑名单(`Host`、`Cookie`、`Proxy-*`) |
| `fatcat/items.upsert` | `items` 中有该 `type` | 写入的条目 `source` 固定为 `plugin:<id>`,只能挂在本插件注册的类别下;每次最多 500 条                                                                                                                                                       |
| `fatcat/log`          | 无(总是允许)          | 写主程序日志,字段 `plugin=<id>`,每分钟最多 60 条,超出丢弃;单条截断到 1,000 字符                                                                                                                                                           |

- 被拒绝的调用返回 JSON-RPC 错误 `permission_denied`,并写一条 `plugin_events`(第 7 节,`kind = 'denied'`,只存方法名与被拒原因,不存参数正文)。同一插件 1 分钟内被拒超过 20 次时停用插件并提示用户。
- 密钥不经 RPC 取,见第 4.3 节;没有 `fatcat/secrets.get` 这类方法。
- `net.fetch` 的目的地登记到外连清单(ADR 0028,类别 `plugin`,每个授权域名一项,`origin` 为 `https://<域名>`,通配写法如实显示)。

### 3.4 插件直接联网怎么办(Node 24 的限制)

Node 24 的权限模型管文件、子进程、worker、addon、WASI,**不管网络**。所以「声明了 `net` 才能联网」在 M7 由三层共同保证,而不是一道硬墙:

1. **运行时预加载**(`--import` 主程序自带的预加载脚本,在插件代码之前运行):删除全局 `fetch`、`WebSocket`、`EventSource`;用模块解析钩子拒绝 `node:net`、`node:tls`、`node:http`、`node:https`、`node:http2`、`node:dgram`、`node:dns`、`node:child_process`、`node:worker_threads`、`node:inspector`;`process.binding` 置为抛错。SDK 的 `ctx.fetch` 走 `fatcat/net.fetch`。
2. **市场审核**:索引仓库的 CI 对包做静态检查(打包产物里不得出现上述模块名、`process.binding`、`eval` / `new Function` 动态拼接这些名字),人工审核 PR(第 5.2 节)。
3. **将来的硬隔离**:Node 的网络权限(`--allow-net`)进入 LTS 后,运行时检测到就启用,上面第 1 层变为后备。

这是纵深防御,不是沙箱:恶意代码仍可能找到绕过第 1 层的办法。安装界面对「本地目录、未签名」的插件额外显示一句「未经市场审核」。(问题 2)

## 4. 进程隔离

### 4.1 启动方式

每个启用的插件一个子进程:

```
<process.execPath>
  --permission
  --allow-fs-read=<插件代码目录>,<插件数据目录>,<预加载脚本>
  --allow-fs-write=<插件数据目录>
  --max-old-space-size=64 --max-semi-space-size=2
  --import=<预加载脚本>
  <插件代码目录>/<entry.main>
```

- 不给 `--allow-child-process`、`--allow-worker`、`--allow-addons`、`--allow-wasi`。
- `spawn` 用 `shell: false`,stdio 三条管道,其余文件描述符不继承;`cwd` 为插件数据目录;子进程优先级调低一档(`os.setPriority`,Windows 同样有效),对话优先。
- 目录:代码在 `<数据目录>/plugins/<id>/<version>/`(只读),数据在 `<数据目录>/plugin-data/<id>/`(读写)。两者都不在 `secrets.yaml`、`secrets.yaml.enc`、`master.key`、`db.sqlite`、`backups/`、`logs/` 的路径之下,权限模型拒绝读取这些文件。
- 已知的 Node 权限模型限制:**符号链接会被跟随到允许范围之外**。对策:安装时拒绝包含符号链接或硬链接的包(第 5.4 节);每次启动前检查插件数据目录,发现符号链接就拒绝启动并提示用户(插件自己不能建符号链接,检查是防用户或别的程序放进去)。越权用例覆盖这一条(第 11 节 PR 2)。
- 进程退出:工具注销,状态 `stopped`;非正常退出 5 分钟内超过 3 次则状态 `error`,不再自动拉起,用户手动启用即可重试。服务器关闭时先发 `SIGTERM`(Windows 为 `kill()`),5 秒后强杀。

### 4.2 环境变量

子进程的环境**不继承**主程序的环境,只有:`PATH`、`SYSTEMROOT` / `WINDIR`(Windows 运行所需)、`LANG`、`TZ`(用户时区,ADR 0023)、`HOME` 与 `TMPDIR` / `TEMP` / `TMP`(都指向插件数据目录下的 `home/`、`tmp/`)、`FATCAT_PLUGIN_ID`、`FATCAT_PLUGIN_DATA`,以及第 4.3 节绑定的密钥。`NODE_OPTIONS`、`NODE_PATH` 一律不传。`FATCAT_AI_*` / `AIP_*` 永远不传。

### 4.3 密钥:只用 `env:` 引用,经启动环境传入

- 清单声明密钥**名字**;用户在插件设置里把每个名字绑定到一个 `env:<变量名>` 引用(只接受 `env:`,不接受 `file:`,也不接受明文值)。数据库只存 `{ "WEATHER_API_KEY": "env:MY_WEATHER_KEY" }`。
- 启动子进程时,主程序从**自己的**进程环境读出 `MY_WEATHER_KEY` 的值,以声明的名字 `WEATHER_API_KEY` 放进子进程环境。这就是受控通道:值只在启动那一刻经操作系统的进程环境传递,不经 RPC、不落盘、不进日志。
- 主程序环境里没有对应变量时:`required` 的密钥让启动失败(状态 `error`,提示缺哪个变量名);可选的不传。
- 改绑定后重启插件生效。卸载时绑定随插件行删除,环境变量本身不动。
- 不支持 `file:`(即 `secrets.yaml`)的理由:让插件密钥与模型、渠道密钥分开,插件出问题时影响面只是部署者为它单独设的那几个环境变量。

## 5. 安装来源

M7 只有两种来源:**本地目录**与**市场**。开发计划原写的 npm 与 Git 不做(问题 6):`npm install` 会执行依赖的生命周期脚本,Git 仓库需要构建步骤,两者都在授权之前执行了别人的代码。插件必须以「已打包好、带全部依赖」的形式分发,安装过程不运行插件的任何代码。

### 5.1 本地目录

- 入口:CLI `fatcat plugins install --from <绝对路径>` 与 API(`POST /plugins/prepare`,`source: { kind: 'local', path }`)。Web 上同样可以填路径(只有登录的主人能用,路径是服务器所在机器上的路径)。
- 目录被**复制**进 `plugins/<id>/<version>/`,不在原处运行;复制时执行第 5.4 节的全部检查。记录内容的 sha256。
- 界面标「本地 · 未签名 · 未经市场审核」。

### 5.2 市场

- **官方索引仓库**:一个公开的 GitHub 仓库(推荐名 `CodingLossy/fatcat-plugins`,问题 3),作者通过 PR 上架,仓库 CI 跑清单校验与第 3.4 节的静态检查,维护者人工审核后合并。合并后由维护者在本机签名并发布 `index.json` 与 `index.json.sig`(GitHub Pages 或仓库 Release)。
- **客户端配置**:`config.yaml` 的 `plugins.markets`,默认只有官方一项:`{ id: 'official', indexUrl, publicKeys: [{ keyId, ed25519 }] }`。官方公钥内置在主程序里。用户自己加的市场只能写在 `config.yaml`(Web 不能加),默认没有。(问题 9)
- **索引格式**(`index.json`,上限 4 MiB):

```json
{
  "formatVersion": 1,
  "market": "official",
  "serial": 42,
  "generatedAt": "2026-12-01T08:00:00Z",
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
          "yanked": false
        }
      ],
      "licensing": { "model": "free" }
    }
  ]
}
```

- **签名**:`index.json.sig` 是对 `index.json` 原始字节的 Ed25519 签名(base64,带 `keyId`),用 `node:crypto` 验证,不引入依赖。包的 sha256 写在已签名的索引里,所以验证了索引就间接验证了每个包。作者级签名(sigstore 等)不做,索引版本条目预留可选字段 `signatures`,M7 忽略。
- **防回滚**:客户端缓存上一次验证通过的索引;新索引的 `serial` 必须大于等于缓存的,否则不采用。
- **浏览与搜索**:在客户端对缓存的索引过滤(名称、描述、id),不做服务端搜索。索引只在用户打开市场页或点「刷新」时下载,不定时拉取(零遥测:只发一个 GET,不带任何标识)。
- 索引里每个插件的 `permissions` 只用于列表展示;**授权以包内 `plugin.json` 为准**,两者不一致时拒绝安装(`plugin_manifest_mismatch`)。

### 5.3 下载与失败处理

| 情况                                   | 处理                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 索引下载失败(网络、超时 30 秒、非 200) | 继续用缓存的索引,界面显示「索引更新失败,显示的是 <时间> 的版本」;没有缓存则市场页显示错误与重试按钮                  |
| 索引签名无效 / 未知 `keyId` / 格式错误 | **不采用**,保留缓存;写 `plugin_events(kind='market-rejected')`;界面显示「索引签名无效,已忽略」                       |
| 索引 `serial` 小于缓存                 | 同上(疑似回滚)                                                                                                       |
| 包下载失败                             | 删除暂存文件,不改动已安装的任何东西;错误码 `plugin_download_failed`;不自动重试,用户点重试                            |
| 包超过 `size` 或 50 MiB 上限           | 中止下载,同上,`plugin_too_large`                                                                                     |
| sha256 不符                            | 删除暂存文件,`plugin_checksum_mismatch`,写 `plugin_events(kind='checksum-mismatch')`,界面红字提示,不提供「仍然安装」 |
| 解包检查失败(第 5.4 节)                | 删除暂存目录,`plugin_package_invalid` 并附具体原因                                                                   |

- 下载只允许 `https:`,主机必须在索引的 `downloadHosts` 中(每一跳重定向都检查,最多 5 跳),解析地址经 `net-guard`。市场 `indexUrl` 的主机与 `downloadHosts` 登记到外连清单(ADR 0028,类别 `plugin`)。
- 暂存在 `<数据目录>/plugins/.staging/<随机名>/`;启动时清理 24 小时前的暂存目录。

### 5.4 解包与包检查(两种来源共用)

- 包格式 `.tgz`(ustar + gzip)。用 `node:zlib` 解压,**自写最小 tar 读取器**(约 150 行),只接受普通文件与目录条目;遇到符号链接、硬链接、设备文件、绝对路径、含 `..` 的路径、重复路径一律整体拒绝。本地目录复制时同样拒绝符号链接与硬链接(`nlink > 1`)。
- 上限:解压后总大小 200 MiB、文件数 5,000、单个文件 50 MiB、路径长度 240 字符(Windows 兼容)。
- 包根必须有 `plugin.json`,schema 校验通过,`entry.main` 存在;`engines.fatcat` 不满足当前核心版本时拒绝(`plugin_incompatible`)。
- 安装完成后对代码目录计算一次「目录 sha256」(按路径排序的文件路径 + 内容哈希,复用 `apps/server/src/data-dir.ts` 已有的目录哈希写法),存进 `plugins.content_sha256`;每次启动前重算比较,不符则拒绝启动(状态 `error`,提示「插件文件被改动」)。

## 6. 卸载与升级

### 6.1 卸载

卸载对话框有一个勾选项「同时删除插件数据」,**默认不勾**(问题 4)。

| 对象                                           | 不勾(默认)                                                    | 勾选                   |
| ---------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| 子进程                                         | 停止                                                          | 停止                   |
| `plugin.<id>.*` 工具注册                       | 注销                                                          | 注销                   |
| `tool_preauth` 中 `plugin.<id>.` 开头的条目    | 删除,按 `preauth-revoked` 审计(同 ADR 0013)                   | 同左                   |
| `pending` 的 `approval_requests`               | 标为 `cancelled`                                              | 同左                   |
| 代码目录 `plugins/<id>/`                       | 删除                                                          | 删除                   |
| 知识地图里 `source = 'plugin:<id>'` 的条目与边 | 删除(内容在插件里,留着打不开)                                 | 删除                   |
| `plugins` 行                                   | 保留,`state = 'uninstalled'`(设置值与密钥绑定留着,重装时沿用) | 删除                   |
| 数据目录 `plugin-data/<id>/`                   | 保留                                                          | 删除                   |
| `plugin_events`、`audit_log`                   | 保留                                                          | 保留(审计不随卸载删除) |

- 引用了该插件工具的定时任务不自动改动,卸载前对话框列出这些任务;卸载后任务运行时按「未知工具」失败并写明原因(与 ADR 0039 第 4 节一致)。
- 卸载是幂等的:中途失败(比如 Windows 上文件被占用)时状态为 `uninstalling`,下次启动继续完成。
- 自动备份只包含数据库;`plugin-data/` 不在自动备份里,文档写明。

### 6.2 升级

1. 下载 / 复制新版本到暂存目录,做第 5.3、5.4 节的全部检查。
2. **权限对比**:新清单的权限不超出已授权范围时直接继续;有任何新增(新工具、工具级别升高、新域名、新密钥、新类别)时进入 `upgrade-pending`,界面列出差异,用户同意后才继续,期间旧版本照常运行。权限减少不需要同意。
3. **备份插件数据**:把 `plugin-data/<id>/` 复制到 `plugin-data/.backup/<id>/<旧版本>/`(超过 500 MiB 时不复制,提示用户「升级失败将无法自动恢复数据」并要求再次确认)。
4. 新版本放进 `plugins/<id>/<新版本>/`;停止旧进程;用新版本启动,**健康检查**:30 秒内完成 MCP 握手、`tools/list` 成功且声明的工具都在。
5. 成功:`plugins` 行更新 `version`、`previous_version`、`granted_json`、`content_sha256`;保留上一个版本的代码目录与数据备份各一份(更早的删除),设置页可「回退到上一版本」。
6. **失败回滚**:停止新进程 → 用备份恢复 `plugin-data/<id>/` → 用旧版本启动 → 删除新版本目录 → 写 `plugin_events(kind='upgrade-failed')` 并在界面显示原因。数据库里的 `plugins` 行在第 5 步之前不改,所以回滚只涉及文件。
7. 核心升级后某插件的 `engines.fatcat` 不再满足:状态 `incompatible`,不启动,提示升级插件;不自动卸载。

## 7. 数据库设计(迁移 0018)

迁移 0018 只新增两张表,不改已有表。**含迁移的 PR(第 11 节 PR 2)合并前需业主确认**;迁移前按 ADR 0005 自动备份。

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
  settings_json    TEXT NOT NULL DEFAULT '{}',
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
             'disabled','denied','checksum-mismatch','market-rejected','crashed')),
  detail     TEXT                                -- 短文本:方法名、错误码;不存参数与正文
);
CREATE INDEX idx_plugin_events_owner_at ON plugin_events(owner_id, at, id);
```

- **为什么新建 `plugin_events` 而不扩展 `audit_log`**:`audit_log.action` 有 CHECK 约束,SQLite 改 CHECK 要重建整张表,审计表可能很大,重建风险高。插件工具的**调用**照常写 `audit_log(action='tool-call')`,不受影响;安装、越权等生命周期事件进新表。设置页「审计」页把两张表按时间合并显示。(问题 7)
- `plugin_events` 保留 180 天,由现有每日维护任务清理(与 `audit_log` 的保留策略一致)。
- `ownerId` 照常预留(1.0 单用户)。
- 回滚说明:迁移只新增表;回退到旧版本时旧代码不认识这两张表也不会读它们,可直接使用迁移前的自动备份恢复。
- 不入库的:市场索引缓存(`plugins/.market/<market>.json` 与 `.sig`)、插件进程状态(只在内存,同 ADR 0013 第 3 节)。

## 8. 内存预算

- **主程序**:空闲 250 MiB 上限与基线规则(ADR 0018)**不变**。插件管理代码与 MCP 客户端一样按需 `import()`:没有启用任何插件时不加载,CI 的空闲门禁测的仍是无插件的情况。启用插件时主程序侧的增量(管理器、RPC 路由、每个连接的缓冲)单独测,上限写进 `.github/memory-baseline.json` 的 `pluginHostIncrementMiB`,初值按实测 × 1.5 向上取整到 5 MiB(预计 ≤ 10 MiB)。
- **插件进程**单独计算,不计入主程序:
  - 每个插件:V8 老生代 64 MiB、新生代半空间 2 MiB(启动参数,Node 自己强制);RSS 上限 **128 MiB**,Linux 上每 30 秒读 `/proc/<pid>/status` 的 `VmRSS`,连续两次超限则停止进程并记 `crashed`;Windows 只依赖 V8 堆上限(不引入依赖去读其他进程内存),文档写明。
  - 一个空的 Node MCP 进程实测约 40–50 MiB RSS(PR 2 测量后写入本节)。
  - **按需启动,空闲停止**:插件在第一次被调用(工具调用、知识地图展开)时启动,空闲 10 分钟后停止;冷启动约 0.3–0.5 秒。**同时运行的插件进程最多 3 个**(`plugins.maxRunning`,可设 1–8),超出时停止最久未用的一个。(问题 5)
- **2C2G 机器上的影响**:最坏情况下主程序对话峰值 400 MiB + 3 个插件 × 128 MiB = 784 MiB,加上系统与 Caddy 约 400 MiB,合计约 1.2 GiB,低于 2 GiB 并留有余量;常见情况(1 个插件在跑)约主程序 120 MiB + 插件 50 MiB。CPU:插件进程优先级调低一档,两个核上对话不被插件挤占。把 `maxRunning` 调高时设置页提示每多一个约多占 128 MiB。
- CI:新增 `scripts/perf/plugin.mjs`(`pnpm perf:plugin`),用示例插件测主程序增量与插件进程的空闲 RSS、连续 100 次工具调用后的回落;沿用 ADR 0018 规则 3、4。

## 9. API 与界面(`/api/v1` 增量,不破坏 ADR 0030 冻结的部分)

| 端点                                                  | 说明                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plugins`                                        | 已安装列表,含状态、版本、授权、来源                                                                                                       |
| `POST /plugins/prepare`                               | `source: { kind: 'local', path } \| { kind: 'market', market, id, version }`;下载 / 复制并检查,返回 `stagingId`、清单、权限(升级时含差异) |
| `POST /plugins/install`                               | `{ stagingId, accept: true }`;完成安装或升级                                                                                              |
| `PATCH /plugins/{id}`                                 | `enabled`、`secretRefs`、`settings`                                                                                                       |
| `POST /plugins/{id}/rollback`                         | 回退到上一版本(走第 6.2 节第 4–6 步)                                                                                                      |
| `DELETE /plugins/{id}?purgeData=`                     | 卸载                                                                                                                                      |
| `GET /plugins/market`、`POST /plugins/market/refresh` | 缓存的索引与刷新                                                                                                                          |
| `GET /plugins/{id}/events`                            | 该插件的事件                                                                                                                              |

全部需要登录,修改类需要 CSRF;**没有对应的 Agent 工具**,模型不能安装、升级、启用或改授权(同 ADR 0013 第 2 节)。Web 新增「插件」页:已安装、市场、安装确认(权限清单)、设置(按 `settings` schema 渲染的表单与密钥绑定)、卸载对话框。插件的任何文本(名称、描述、设置标签)都按纯文本显示。

## 10. 变现预留(本期不实现)

只定扩展点,让以后加付费插件时不需要改清单版本、索引格式或表结构的含义:

1. **清单 `licensing`**:`{ "model": "free" | "paid" | "trial", "vendor"?: string, "verifyKeyId"?: string }`。M7 只接受 `free`,其他值安装时拒绝(`plugin_licensing_unsupported`),这样旧核心不会错误地运行付费插件。
2. **索引 `licensing`**:与清单同形,外加以后的 `price`、`purchaseUrl`;M7 客户端只显示 `free` 的插件,其他条目隐藏。
3. **授权校验钩子**:插件状态机在「启动进程」之前有一步 `LicenseCheck.verify(plugin) → ok | { denied, reason }`,M7 的实现恒为 `ok`。以后实现时优先用**离线可验证的授权文件**(厂商 Ed25519 签名,存 `plugin-data/<id>/license`),不在启动时联网,保持零遥测;需要联网激活的方案必须在外连清单登记并由用户主动触发。
4. **授权交给插件**:以后通过启动环境传一个 `FATCAT_PLUGIN_LICENSE` 路径(只读),与密钥同一条受控通道;插件自行决定功能开关。
5. **商业边界**:付费插件是第三方独立作品(第 15.5 节),核心的 AGPL / 商业双许可不受影响;官方市场收录付费插件的规则(分成、审核)以后另写 ADR。

## 11. 实现 PR 拆分

按 CLAUDE.md:同一时间只开一个功能 PR;每个 PR 做完整(后端、前端、测试、文档一起);含迁移的 PR 由业主确认后合并。「任务工具集声明」(ADR 0039 第 4 节)是独立的小 PR,排在本设计 PR 之后、PR 1 之前,不混进下列任何一个。

| #   | 分支                       | 范围                                                                                                                                                                                                                                                                                                                                               | 验收标准                                                                                                                                                                                                                                                                                                                               | 自测                                                                                                   | 风险 / 真机                                                                                                                                   |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat/plugin-manifest`     | `packages/shared/src/plugin.ts`(清单、索引、`fatcat/*` 消息的 zod schema);`engines` 版本范围解析;`packages/plugin-sdk`(`definePlugin`、`registerTool`、`registerItemProvider`、`ctx.fetch`、`ctx.log`、自带 stdio MCP 服务端);`examples/plugins/hello`(SDK 写的示例)                                                                               | 清单 schema 拒绝未知字段、越界值、`broad` 域名、`FATCAT_AI_` 密钥名;示例插件能被 ADR 0013 的客户端当普通 MCP 服务器连接并调用;SDK 包许可证头为 Apache-2.0                                                                                                                                                                              | `pnpm lint`、`typecheck`、`check:spdx`、`check:licenses`;shared 与 plugin-sdk 的单测                   | 低;无迁移;不需要真机                                                                                                                          |
| 2   | `feat/plugin-runtime`      | **迁移 0018**;插件管理器(按需加载)、第 4 节的启动方式与预加载、环境与密钥绑定、按需启动 / 空闲停止 / `maxRunning`、RSS 监控、`fatcat/log` 路由、工具注册与第 3.2 节审批规则;本地目录安装、启用 / 停用、卸载;第 9 节 API(市场端点除外);CLI `plugins install/list/remove`;Web 插件页(已安装、安装确认、设置、卸载);外连清单;`perf:plugin` 与基线字段 | 本地目录安装示例插件后可在对话中调用(经审批);卸载后第 6.1 节表格的每一项都符合;越权用例全部被拦:读 `master.key` / `secrets.yaml.enc` / `db.sqlite`、读其他插件数据目录、数据目录里的符号链接、启动子进程、`require('node:net')`、全局 `fetch`、未声明工具、未授权的 `fatcat/*` 方法、`FATCAT_AI_*` 环境变量;主程序无插件时空闲内存不变 | 受影响包的单测与集成测试;`pnpm perf:plugin`;Web 页面在浏览器里点过并附截图;PR 描述写迁移前后测试与回滚 | **高**(迁移、安全、内存);**业主确认迁移后合并**;Windows 真机:权限模型对 `C:\` 路径与含中文 / 空格的数据目录的拦截、进程停止、`os.setPriority` |
| 3   | `feat/plugin-capabilities` | `fatcat/net.fetch`(域名匹配、net-guard、重定向、大小与超时)、`items` 提供者(`roots/children/open`、`items.upsert`、卸载清理)、`settings` 表单、`taskTemplates`(从模板建任务草稿,走确认卡);示例插件补上这些能力                                                                                                                                     | 未授权域名、私网地址、重定向到私网、超大响应都被拒并写 `denied` 事件;插件条目出现在知识地图浏览器且能打开;卸载后条目消失;模板建任务必须经确认卡                                                                                                                                                                                        | 单测 + 越权用例;Web 截图(设置表单、知识地图里的插件类别、模板建任务)                                   | 高(网络与安全);无迁移;不需要真机                                                                                                              |
| 4   | `feat/plugin-market`       | 市场配置与内置公钥;索引下载、Ed25519 验签、`serial` 防回滚、缓存;包下载(`downloadHosts`、重定向检查、大小上限)、sha256;第 5.4 节的 tar 读取器;Web 市场页(浏览、搜索、安装);外连清单登记;索引仓库的格式说明与 CI 检查脚本(放在本仓库 `scripts/plugins/`,供索引仓库引用)                                                                             | 用测试密钥签的本地假索引能浏览并安装;签名错误、未知 `keyId`、`serial` 回退、sha256 不符、包含符号链接 / `..` / 超限的包、`downloadHosts` 之外的重定向都被拒且已安装的东西不变;下载中断后暂存目录被清理                                                                                                                                 | 单测(假 HTTP 服务器,不联网);Web 截图                                                                   | 高(网络、供应链);无迁移;需业主:建索引仓库、在本机生成签名密钥(私钥不进仓库)                                                                   |
| 5   | `feat/plugin-upgrade`      | 第 6.2 节升级流程:权限差异与再次同意、数据备份、健康检查、失败回滚、手动回退、`incompatible` 状态                                                                                                                                                                                                                                                  | 无新增权限时直接升级;新增权限时旧版本继续运行直到同意;健康检查失败时数据与旧版本完整恢复;回退后可再次升级                                                                                                                                                                                                                              | 单测 + 用故意坏掉的示例版本做回滚集成测试;Web 截图(权限差异、失败提示)                                 | 高(数据回滚);无迁移;Windows 真机:升级时文件占用与目录替换                                                                                     |
| 6   | `docs/m7-wrapup`           | M7 自检(`docs/milestones/M7-self-check.md`):对照验收逐条记录;插件开发指南(中英,英文标注待校对)、CHANGELOG;把一个第三方 JS MCP 服务器打包成插件、一个 SDK 插件上架到官方索引                                                                                                                                                                        | 从市场一键安装一个打包的 MCP 插件和一个 SDK 插件;卸载干净;越权调用被拦截(开发计划 M7 验收)                                                                                                                                                                                                                                             | 按自检清单                                                                                             | 中;需业主在 Windows 真机与 2C2G Linux 上各装卸一次并看内存                                                                                    |

## 12. 待业主决定的问题(均附推荐)

1. **非 JS 插件(Python、二进制)能否上架市场?** 推荐:M7 不能。没有零依赖、跨平台的文件隔离,做不到「读不到 `master.key`」;这类服务器继续用 ADR 0013 的手动 MCP 配置并标注「未隔离」。以后有了操作系统级沙箱(Linux landlock / bubblewrap、Windows AppContainer)再单独写 ADR。
2. **接受「网络限制是纵深防御而不是硬墙」吗?** 推荐:接受。Node 24 的权限模型不管网络,M7 用预加载 + 市场审核两层,Node LTS 有网络权限后自动启用第三层。不接受的替代是 M7 只上架「不联网」的插件,用处会小很多。
3. **官方索引仓库名与签名私钥保管。** 推荐:仓库 `CodingLossy/fatcat-plugins`;Ed25519 私钥由业主在自己电脑上生成并离线保管(不放 GitHub Secrets,避免 CI 被攻破后签出恶意索引),每次发布索引时在本机签名;主程序内置公钥,预留第二把公钥位用于轮换。
4. **卸载时插件数据默认保留还是删除?** 推荐:默认保留,对话框勾选才删除;重装时沿用设置与密钥绑定。
5. **插件进程按需启动、空闲 10 分钟停止、最多同时 3 个?** 推荐:是。2C2G 下最坏约 1.2 GiB,常见情况只多约 50 MiB;代价是冷启动多 0.3–0.5 秒。
6. **去掉开发计划原写的 npm、Git 安装来源?** 推荐:去掉。两者都会在授权前运行别人的代码(生命周期脚本、构建步骤);作者可以把打好的 `.tgz` 发到 GitHub Release 再上架,或者用户本地构建后用「本地目录」安装。
7. **生命周期事件写新表 `plugin_events`,不扩展 `audit_log`?** 推荐:新表。改 `audit_log` 的 CHECK 要重建大表;插件工具调用仍进 `audit_log`。
8. **能联网的插件,其 `read` 工具按 `write` 审批?** 推荐:是(仍可预授权),防止对话内容被无提示带出。
9. **允许用户添加第三方市场吗?** 推荐:只允许在 `config.yaml` 里加(必须同时写公钥),Web 不提供入口,默认没有第三方市场。

例外:迁移 0018 所在的 PR 2 必须业主明确同意后才能合并;第 3 题的密钥生成由业主本人操作。

## 后果

- 插件只有一种运行方式(子进程 + MCP),隔离与权限检查只实现一次;ADR 0013 的客户端增加 `fatcat/*` 路由,手动 MCP 服务器行为不变。
- 主程序空闲内存不变;插件进程有单独上限和数量上限。
- 新增两张表(迁移 0018),无已有表改动。
- 不新增运行时依赖:Ed25519、gzip 用 `node:crypto` / `node:zlib`,tar 读取器与版本范围解析自写。
- 已知限制:插件直接联网只能纵深防御(第 3.4 节);Windows 上插件 RSS 不做强制上限;M7 不支持非 JS 插件、插件渠道、插件 UI 脚本。

# ADR 0028 · 外连目标清单

- 状态:已采纳(M5b PR 3;实现在 PR 6 `feat/egress-targets`)
- 日期:2026-11-13
- 相关:开发计划第 10 节(零遥测)、ADR 0006(模型配置)、ADR 0011/0014/0022(邮件、渠道)、M5b 方案 PR 6
- 依据:开发计划验收项 4——设置页的外连目标清单与实际外连一致。

## 背景

「零遥测」是对用户的承诺。仅靠文字承诺不可核对;需要一份由配置现算出来的清单,并有机制保证清单没有漏项。

## 决定

### 1. 接口

`GET /api/v1/settings/egress-targets`(需要登录,只读,无副作用)→ `EgressTargetList { targets: EgressTarget[] }`(shared:`packages/shared/src/egress.ts`)。每项:

| 字段       | 含义                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `id`       | 稳定 id,如 `model:<profileId>`、`mail:<accountId>:imap`、`mail:<accountId>:smtp`、`channel:<id>` |
| `category` | `model` / `embedding` / `voice` / `mail` / `channel` / `mcp` / `plugin` / `update-check`         |
| `label`    | 用户配置的显示名;不可信文本,Web 按纯文本显示                                                     |
| `origin`   | 只到 `协议://主机[:端口]`;不含路径、查询、片段、用户信息;`local` 为 true 时为 `null`             |
| `local`    | stdio 类 MCP 服务器为 true:本地进程,**其自身的外连不在清单内**,界面如实标注                      |
| `source`   | `{ kind, id }`,指向产生它的配置对象(模型配置档、邮件账户、渠道、MCP 服务器…)                     |
| `enabled`  | 当前是否会被使用(停用的渠道、没有开启的语音为 false;仍列出,让用户看到「如果开启会去哪里」)       |

- 清单由配置现算,不入库,无迁移。同一个 `origin` 可出现多项(分属不同配置对象)。
- `origin` 规范化:小写协议与主机、省略默认端口、丢弃路径/查询/凭据;无法解析的配置跳过该项并在日志记一条(不含地址)。
- 渠道:微信 iLink 的 `origin` 来自适配器的基础地址;企业微信推迟,不出现。
- `plugin`:插件声明的网络访问(SDK 声明字段在插件 PR 里定);当前没有插件,类别保留。
- `update-check`:**当前代码里没有更新检查,清单中不出现这一类**。将来加入时必须在同一个 PR 里登记(`check-egress` 会强制)。
- `web.fetch` 之类由用户逐次审批、目的地由对话决定的工具调用不是固定目标,不列在清单里;设置页在清单下方用一句话说明,并且这类调用点在登记表里标 `dynamic`(第 3 节)。

### 2. 一致性测试(`apps/server/src/egress.test.ts`)

假端点下把每一类外连各走一遍(模型、嵌入、语音、IMAP/SMTP、微信 iLink、HTTP/SSE 类 MCP):用 `node --import` 式的 `fetch`/`net`/`tls` 钩子记录所有真实目的地(只记录 origin),断言每个目的地都能在 `GET /settings/egress-targets` 的 `origin` 中找到;反过来,清单中 `enabled` 的项必须至少被某个路径用到过(防止清单里留着不再使用的项)。

### 3. `scripts/check-egress.mjs` 与登记表

CI 脚本(`pnpm check:egress`,接入 `ci.yml`)扫描生产代码(不含测试、`dist`、`node_modules`)里使用网络 API 的文件:`fetch(`、`node:net`、`node:tls`、`node:http`、`node:https`、`node:dgram`、`new WebSocket(`、`undici` 等客户端。规则:

1. 每个命中的文件必须出现在登记表 `scripts/egress-registry.json` 里;每条登记包含 `file`、`kind`(`fixed`:对应清单中的某个 `category`;`dynamic`:目的地由审批的工具调用决定;`local-only`:只连 127.0.0.1/本机套接字/浏览器同源,例如 Web 客户端的 `fetch` 与服务器自己的监听)、`listedAs`(清单来源:产生 `EgressTarget` 的函数或配置对象)、一句 `reason`。
2. 登记表里有而代码里没有网络调用的条目也失败(防止登记表腐烂)。
3. 新增网络调用点必须同 PR 登记并写明清单来源;`kind: fixed` 的条目其 `listedAs` 必须能在 `apps/server/src/egress.ts` 中找到对应符号。
4. `apps/web` 与 `packages/client` 只对同源 `/api/v1` 发请求,登记为 `local-only`;依赖中引入新的网络客户端库同样触发失败(与 `check:licenses` 的依赖检查一起看)。
5. 脚本是静态文本扫描,会有误报;误报通过在登记表里写 `kind: local-only` 加理由处理,不加通配符。

### 4. 脱敏

清单与日志都不含凭据:`origin` 的正则(`EgressOrigin`)拒绝路径、查询、片段、`user:pw@`;测试用含这些部分的配置验证输出被规范化或跳过。

### 5. 文档

README 与文档站首页的零遥测承诺指向这份清单(随 PR 9 的文档核对)。

## 后果

- 零遥测变成可核对的:清单、一致性测试与登记表三者互相约束。
- 静态扫描有维护成本(每个新网络调用点都要登记),这是有意为之。
- 无迁移、无新依赖、无新的外连。

## 实现 PR 的测试清单(PR 6)

- 一致性测试(见第 2 节),覆盖第 1 节每个 `category` 中当前存在的类型。
- `check-egress`:未登记的网络调用点失败;登记了但代码里没有的条目失败;`fixed` 的 `listedAs` 找不到符号失败;通过用例(使用夹具目录,不扫真实仓库)。
- 清单不含路径、查询与凭据(脱敏用例);无法解析的地址被跳过。
- stdio MCP 为 `local: true`、`origin: null`;停用的渠道 `enabled: false`。
- **越权**:未登录 `GET /settings/egress-targets` 返回 401;响应不含任何密钥、`secrets` 引用名之外的值(引用名也不含)。
- 界面:设置页清单一节的截图(桌面、手机宽度各一张)。

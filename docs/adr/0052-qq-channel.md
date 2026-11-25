# ADR 0052 · QQ 官方机器人渠道(M13 后段 3)

- 状态:提议(按 `docs/milestones/M13-plan.md`「后段顺序」第 3 项;开发计划第 9 节「QQ 官方机器人(优先,可提前到 1.x)」)
- 日期:2026-11-25
- 相关:ADR 0022(渠道框架:绑定、过滤、审批短码、不可信内容、第 9 节密钥写入、第 13 节资料来源)、ADR 0024(微信 iLink 适配器)、ADR 0034 第 3 节(任务的 `channel.push`)、ADR 0050 第 2 节(渠道中枢在 `@fatcat-ai/channels/hub`,包级中枢单测随 QQ 补)、ADR 0004(枚举只增不改)
- 范围:在已有渠道框架上加第二种适配器。绑定、过滤、指令、审批短码、排队、限流、降级与切段全部沿用 ADR 0022,不为 QQ 另写一套。
- 语言:中文;代码标识符、字段名和接口路径保留英文。

## 0. 资料来源(净室)

和 ADR 0022 第 13 节、ADR 0024 第 0 节同样的做法:**只依据 QQ 开放平台的官方文档**(`bot.q.qq.com/wiki`,接口 v2),不读、不复制任何 SDK 或第三方项目的源代码(包括官方的 `tencent-connect/bot-node-sdk`、`botgo`、`botpy`;只允许读它们的 README)。

2026-11-25 已核对的页面:

| 页面                                      | 用到的内容                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 开发准备 · 接口调用与鉴权(`access-token`) | `POST https://api.bot.qq.com/app/getAppAccessToken`,body `{ appId, clientSecret }`;返回 `access_token` 与 `expires_in`(秒,目前不超过 7200);业务错误也是 HTTP 200,要看 `code`(100016 = appid 或 secret 不对);到期前 60 秒内再取会拿到新令牌,旧令牌在这 60 秒里仍然有效;请求头 `Authorization: QQBot <access_token>`                                                                                                                                                       |
| 事件订阅与通知(`event-emit`)              | WebSocket 网关与 Webhook 两种方式;信封 `{ id, op, d, s, t }`;op 10 Hello(`heartbeat_interval`)、op 2 Identify(`token: "QQBot <access_token>"`、`intents`、`shard`)、op 0 `READY`(`session_id`)、op 1 心跳(`d` 为最后收到的 `s`)、op 11 心跳回执、op 6 Resume(`token`、`session_id`、`seq`)、op 7 要求重连、op 9 会话失效;`GROUP_AND_C2C_EVENT = 1 << 25` 包含单聊消息 `C2C_MESSAGE_CREATE` 和群 @ 消息 `GROUP_AT_MESSAGE_CREATE`;请求没有权限的 intents 时网关报错并断开 |
| 签名校验(`sign`)                          | Webhook 用 Ed25519:种子由 Bot Secret 重复拼到至少 32 字节后取前 32 字节;回调头 `X-Signature-Ed25519` / `X-Signature-Timestamp`,签名内容为时间戳 + 原始 body(本 ADR 不用 Webhook,见第 1 节)                                                                                                                                                                                                                                                                               |
| 快速入门(`getting-started`)               | 凭据是 AppID 与 AppSecret;旧的 Token 鉴权已废弃,只用 Access Token                                                                                                                                                                                                                                                                                                                                                                                                        |

**还没核对到的**:「消息事件」与「发送消息」两页(`server-inter/message/send-receive/event.html`、`send.html`)在本会话里会被重定向到 `q.qq.com` 首页,没有读到。下面第 3、4 节依赖这两页的字段名与限制,标了 **〔待核对〕**。实现 PR 开工时先读这两页;读不到或和本 ADR 不一致时,在实现 PR 里列出差异等业主决定,不去看 SDK 代码。

## 1. 决定(摘要)

1. **只用 WebSocket 网关收事件,不做 Webhook**。Webhook 要求公网 HTTPS 回调地址(端口只能是 80、443、8080、8443),而核心默认只监听 `127.0.0.1`;网关是核心主动连出去,本机就能用,和微信长轮询一样。官方文档目前没有写网关下线的日期;以后如果下线,再写 ADR 加 Webhook(先验签再处理,见上表)。
2. **只处理单聊**。intents 只请求 `GROUP_AND_C2C_EVENT`(`1 << 25`);`C2C_MESSAGE_CREATE` 是私聊,`GROUP_AT_MESSAGE_CREATE` 映射成 `chat: 'group'`,由框架按 ADR 0022 第 3 节规则 1 忽略。频道(guild)事件不请求。
3. **绑定沿用配对码**:外部账号是平台给的 `user_openid`(每个机器人一套,不是 QQ 号),在私聊里发「绑定 123456」。API 和日志只出现打码后的末 4 位,和微信相同。
4. **凭据由主人在 Web 填写**:AppID 存在渠道配置里(不是密钥),AppSecret 按 ADR 0022 第 9 节写进 `secrets.yaml` 的 `QQBOT_SECRET_<channelId>`,配置里只记 `file:` 引用。没有填凭据或凭据被平台拒绝时状态为 `needs-login`,不重试。
5. **回复用被动消息**:回复带上触发它的那条入站消息的 id(放在 `replyContext`)。主动消息(没有可回复的入站消息,例如定时任务的 `channel.push`)平台可能限制或不再提供 〔待核对〕;发不出去时按普通发送失败处理,任务运行记失败并带平台的错误码,不重试,也不改用别的渠道。
6. **纯文本**:`markup: 'none'`,和微信同一套降级。QQ 的 markdown 消息需要平台另外开通的权限与模板,1.0 不做。

## 2. 契约变化(`packages/shared`,只增不改)

- `ChannelKind` 增加 `'qq'`:`z.enum(['wechat', 'qq'])`。响应里多一个枚举值是 ADR 0004 允许的增量(`oasdiff` 对 `response-property-enum-value-added` 只报警告,`.github/oasdiff-severity.txt` 已这样配置);Web 已经按「不认识的渠道」处理未知 kind。
- 新增 `QqCredentials`:`{ appId: string(1..32, 只含数字), appSecret: string(1..128) }`,只用于下面这个请求体,任何响应都不返回 AppSecret 或它的引用。
- 新增 `Channel.qq`(可选,只在 `kind: 'qq'` 时出现):`{ appId: string | null }`。AppID 在 QQ 开放平台的机器人资料页本来就是公开的,返回它方便主人核对填的是哪个机器人。

## 3. 适配器(`packages/channels/src/qq.ts`,AGPL-3.0-only)

### 3.1 访问令牌

- `getAppAccessToken` 的地址固定为 `https://api.bot.qq.com/app/getAppAccessToken`;测试时经构造参数指向本机假服务器。
- 令牌只存在适配器内存里,不写盘;拿到后先登记到脱敏器。到期前 60 秒内(或网关报鉴权失败时)重新获取。
- `code` 为 100016 / 100007(appid 或 secret 不对)→ 报告 `needs-login`,错误码 `qq_credentials_invalid`,不再重试,直到主人在 Web 重新填写。其他错误与网络错误 → `backoff`,按 ADR 0022 第 8 节退避。

### 3.2 网关

- 网关地址从 OpenAPI 的「获取通用 WSS 接入点」接口取 〔待核对:路径与返回字段;文档示例地址为 `wss://api.bot.qq.com/websocket/`〕;只接受 `wss://` 且主机名以 `.qq.com` 结尾、不带用户名密码的地址,否则 `backoff`,错误码 `unexpected_host`(和微信 `isAllowedIlinkUrl` 同理)。
- 连接后:收到 op 10 → 发 op 2 Identify(`intents: 1 << 25`,`shard: [0, 1]`,`properties` 只写 `{ os, browser: 'fatcat-ai', device: 'fatcat-ai' }`)→ 收到 `READY` 记下 `session_id`,报告 `running`。
- 心跳按 `heartbeat_interval` 发 op 1(`d` 为最后收到的 `s`);连续两次没有收到 op 11 视为断线。
- 断线或 op 7:有 `session_id` 时重连并发 op 6 Resume;op 9 或 Resume 失败时丢掉 `session_id` 重新 Identify。重连之间至少隔 1 秒,失败交给框架退避(1 秒起,最长 5 分钟)。`stop()`(`signal`)立即关闭连接,不等心跳。
- 一次只处理一条事件:`await ctx.receive(...)` 返回后再读下一条,内存里不堆积;平台重投的消息由 `channel_inbox` 去重(ADR 0022 第 8 节)。
- 只用 Node 24 自带的 `WebSocket`,不引入依赖。

### 3.3 入站映射 〔待核对:字段名〕

| 平台                                     | `InboundMessage`                                                     |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `C2C_MESSAGE_CREATE` 的消息 `id`         | `externalMessageId`,同时放进 `replyContext`                          |
| `author.user_openid`                     | `externalUserId`                                                     |
| `GROUP_AT_MESSAGE_CREATE`                | `chat: 'group'`(框架忽略;`externalUserId` 取 `author.member_openid`) |
| `content`(去掉首尾空白)                  | `text`                                                               |
| 引用的消息(如果事件里带被引用消息的正文) | `quoted: [{ kind: 'quote', text }]`,不可信                           |
| `timestamp`                              | `receivedAt`(转成 UTC ISO)                                           |
| 附件(图片、语音、文件)                   | 不下载;没有文字时框架回复「暂时只能看文字」                          |

`voiceTranscript: false`:文档里没有看到平台给语音转写,1.0 不做。其他事件(加好友、删好友、主动消息开关、群里加删机器人)不进模型,只记一条不含外部账号的日志。

### 3.4 发送 〔待核对:路径、字段与限制〕

- `POST /v2/users/{openid}/messages`,`{ content, msg_type: 0, msg_id, msg_seq }`:`msg_id` 取 `replyContext`;同一条入站消息的多段回复(切段后最多 10 段)`msg_seq` 从 1 递增,避免被平台当成重复消息。
- 被动回复有时间窗口和次数限制 〔待核对〕。超出窗口或没有 `replyContext` 时不带 `msg_id`(主动消息);平台拒绝时这一段发送失败:框架照旧记日志(只记渠道 id、状态码与平台错误码),一轮里后面的段不再发。
- `capabilities`:`{ markup: 'none', maxTextBytes: 2048, voiceTranscript: false }`。文档没写单条上限前先取 2048 字节,和微信一致 〔待核对〕。
- OpenAPI 的基地址 〔待核对:`https://api.sgroup.qq.com` 或 `https://api.bot.qq.com`〕 固定写在代码里,不接受配置覆盖(测试经构造参数注入);请求都带 `Authorization: QQBot <access_token>`。

## 4. 服务器与 API(`/api/v1`,都需要登录并按 `ownerId` 取数据)

| 方法与路径                          | 说明                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /channels/{id}/qq/credentials` | body `QqCredentials` → 204。按 ADR 0022 第 9 节写 `secrets.yaml`(先备份、只改这一行、解析失败不写、原子改名、Windows ACL),配置记 `appId` 与 `secretRef: file:QQBOT_SECRET_<channelId>`,然后重启这个渠道。只对 `kind: 'qq'`,其他 kind 返回 409(和 `wechat/login` 对非微信渠道一样) |

- 创建、启用、配对、解除绑定、状态、删除都用已有的渠道接口。删除 QQ 渠道时同样只删 `QQBOT_SECRET_<channelId>` 这一行。
- 别人的渠道和不存在的渠道回答相同(ADR 0051 规则 3);新路由登记进 `owner-scope.test.ts` 的 `ROUTE_IDS`。
- 外连清单(`apps/server/src/egress.ts` 的 `channelTargets`)加上 QQ 渠道:地址 `api.bot.qq.com` 与网关主机;`check:egress` 照旧通过。
- `GET /api/v1/meta` 不变(`capabilities.channels` 已经有了)。

## 5. Web

- 「设置 → 渠道」新建时可以选「QQ」。QQ 渠道的卡片上没有扫码,换成「机器人凭据」表单:AppID、AppSecret(密码框,保存后清空,不回显),保存后显示 AppID 与「已保存」;旁边一句说明在 QQ 开放平台的哪里找到这两个值,以及要给机器人开通单聊消息的权限。
- 绑定、状态、错误提示和微信共用现有组件;`qq_credentials_invalid` 显示「凭据不对,请在 QQ 开放平台核对后重新填写」。
- 中英文文案都加(`check:i18n`);文档站「渠道」页加 QQ 一节。

## 6. 测试

- **包级中枢单测**(ADR 0050 第 2 节承诺的):`packages/channels/src/hub/hub.test.ts`,用假的仓储、运行管理与假渠道,覆盖绑定、过滤、指令、审批短码、排队、限流、切段;微信与 QQ 两种适配器共用同一套测试替身。之后 `packages/channels/vitest.config.ts` 不再整体排除 `src/hub/**`。
- **QQ 适配器**:`packages/channels/src/qq.test.ts`,本机假的令牌接口与假网关(Node 自带的 HTTP 服务加最小的 WebSocket 握手,只在测试里):Identify 的 intents、心跳与回执超时、op 7 / 断线后 Resume、op 9 重新 Identify、令牌到期前刷新、100016 → `needs-login`、网关地址不是 `*.qq.com` → `backoff`、`stop()` 立即关闭;入站映射(单聊、群 @、引用、附件);发送带 `msg_id` 与递增的 `msg_seq`。
- **服务器**:`apps/server/src/qq-credentials.test.ts`:凭据写入 `secrets.yaml` 且备份等于原文件、API 和日志里没有 AppSecret、删除渠道后文件恢复原样、解析失败时不写、对微信渠道 409、未登录 401;`channel-injection.eval.test.ts` 已有的用例用假渠道跑,不依赖 kind,不需要复制一份。
- **e2e**:建 QQ 渠道、填凭据、看到 AppID 与状态(网关用假的);手机与桌面截图。

## 7. PR 拆分

一次只开一个,上一个合并后从最新的 `main` 切下一个:

1. `docs/qq-channel-adr`:本 ADR 与计划里的链接。
2. `test/channel-hub-unit`:包级中枢单测与共用的测试替身(第 6 节第一条),不改生产代码。
3. `feat/channel-qq`:契约、适配器、凭据接口、外连清单、Web、文档与 CHANGELOG(第 2–6 节其余部分)。开工时先核对第 0 节列出的两页文档。

## 8. 不做

- Webhook、频道(guild)、群聊、markdown 与按钮消息、图片和文件、语音转写。
- 「发 QQ 给任意用户」的工具(ADR 0022 第 1 节第 5 条照旧)。
- 真实 QQ 机器人的联调:需要业主在 QQ 开放平台建机器人并开通权限,清单写在 `feat/channel-qq` 的 PR 描述里,由业主在真机上验证。

## 9. 待业主决定

1. **只用 WebSocket 网关,不做 Webhook**(第 1 节第 1 条)。推荐:同意。本机默认只监听 `127.0.0.1`,网关不需要公网地址;Webhook 等网关下线或有公网部署需求时再加。
2. **任务的 `channel.push` 发到 QQ 时**,如果平台不允许主动消息,就让这次推送失败并在任务运行里写明平台错误码,不重试、不改发别的渠道(第 1 节第 5 条)。推荐:同意。悄悄改发别处会让主人以为消息到了 QQ。
3. **AppSecret 在 Web 填写,由服务器写进 `secrets.yaml`**(第 4 节),而不是只支持手工编辑 `secrets.yaml` / 环境变量。推荐:同意。和微信扫码后写令牌是同一套已经测过的写入规则,手工编辑仍然可以(配置里的引用也接受 `env:`)。

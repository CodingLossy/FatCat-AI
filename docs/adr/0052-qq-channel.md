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

2026-11-25 `feat/channel-qq` 开工时补读的页面(原先的「消息事件」「发送消息」两页仍跳转到 `q.qq.com` 首页,改读同一内容的自动生成页与概述页):

| 页面                                                           | 用到的内容                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息收发概述(`server-inter/message/overview`)                  | 被动回复带 `msg_id`(回复消息)或 `event_id`(回复事件);**单聊被动回复 60 分钟内有效、每条最多 4 次**;主动消息没有前提条件,但用户可以在 QQ 里关掉「允许主动发送」,单聊主动消息每个用户每天最多 1000 条、每个关系每分钟 20 条;相同 `msg_id` + `msg_seq` 重复发送会失败,多次回复要递增 `msg_seq`                                   |
| 发送单聊消息(`autogen/api/v2_users_user_openid_messages.post`) | `POST /v2/users/{user_openid}/messages`,`msg_type` 0 为纯文本(用 `content`);`msg_id`、`msg_seq`(默认 1);错误码里 304103 / 40034005 / 40034128 是被动回复过期或次数用完,40034024 是 `msg_id` 无效,40034100 / 40034105 是主动消息超频或不允许,40054013 是用户拒收;文档没有给出文本长度上限(只有 40054007「长度超限」这个错误码) |
| 单聊消息事件(`autogen/event/c2c_message_create`)               | `d.id`、`d.author.user_openid`、`d.content`、`d.timestamp`(RFC 3339)、`d.message_type`(0 文本、3 卡片 `ark_data`、102 聊天记录、103 引用,引用和聊天记录的内容在 `d.msg_elements`)、`d.attachments`(语音附件有平台转好的文字 `asr_refer_text`)                                                                                 |
| 群 @ 消息事件(`autogen/event/group_at_message_create`)         | 发送者是 `d.author.member_openid`,另有 `d.group_openid`                                                                                                                                                                                                                                                                       |
| WebSocket 方式(`dev-prepare/event-emit/websocket`)             | `GET /gateway/bot` 返回 `url`(示例 `wss://api.bot.qq.com/websocket`)、`shards`、`session_start_limit`;READY / RESUMED;关闭码:4009(连接过期)与 4008 可以 Resume,4006 / 4007 / 4900–4913 要重新 Identify,4013 / 4014(intents 无效或没有权限)、4914(机器人已下架,只能连沙箱)、4915(机器人被封禁)不要再连                         |
| 更新日志(`changelog`)                                          | 2026-08-10 起所有接口统一为 `api.bot.qq.com`;到 2026-11-17 为止没有网关下线或主动消息停用的公告                                                                                                                                                                                                                               |

原先标了〔待核对〕的地方已按上表改写;和提议版不一致的地方见第 10 节。

## 1. 决定(摘要)

1. **只用 WebSocket 网关收事件,不做 Webhook**。Webhook 要求公网 HTTPS 回调地址(端口只能是 80、443、8080、8443),而核心默认只监听 `127.0.0.1`;网关是核心主动连出去,本机就能用,和微信长轮询一样。官方文档目前没有写网关下线的日期;以后如果下线,再写 ADR 加 Webhook(先验签再处理,见上表)。
2. **只处理单聊**。intents 只请求 `GROUP_AND_C2C_EVENT`(`1 << 25`);`C2C_MESSAGE_CREATE` 是私聊,`GROUP_AT_MESSAGE_CREATE` 映射成 `chat: 'group'`,由框架按 ADR 0022 第 3 节规则 1 忽略。频道(guild)事件不请求。
3. **绑定沿用配对码**:外部账号是平台给的 `user_openid`(每个机器人一套,不是 QQ 号),在私聊里发「绑定 123456」。API 和日志只出现打码后的末 4 位,和微信相同。
4. **凭据由主人在 Web 填写**:AppID 存在渠道配置里(不是密钥),AppSecret 按 ADR 0022 第 9 节写进 `secrets.yaml` 的 `QQBOT_SECRET_<channelId>`,配置里只记 `file:` 引用。没有填凭据或凭据被平台拒绝时状态为 `needs-login`,不重试。
5. **回复优先用被动消息**:回复带上触发它的那条入站消息的 id(放在 `replyContext`),60 分钟内、每条最多 4 次;超出、没有可回复的消息(例如定时任务的 `channel.push`)或平台说被动回复已过期时,发主动消息(每个用户每天最多 1000 条,用户可以在 QQ 里关掉)。主动消息也发不出去时按发送失败处理:任务推送记失败并带平台的错误码,不重试,也不改用别的渠道。
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

- 网关地址从 `GET /gateway/bot` 的 `url` 取;用 `new URL()` 解析,只接受 `wss:`、不带用户名密码、主机名等于 `qq.com` 或以 `.qq.com` 结尾(按点边界,`evilqq.com` 不算)的地址,否则 `backoff`,错误码 `unexpected_host`(和微信 `isAllowedIlinkUrl` 同理)。
- 连接后:收到 op 10 → 发 op 2 Identify(`intents: 1 << 25`,`shard: [0, 1]`,`properties` 只写 `{ os, browser: 'fatcat-ai', device: 'fatcat-ai' }`)→ 收到 `READY` 记下 `session_id`,报告 `running`。
- 心跳按 `heartbeat_interval` 发 op 1(`d` 为最后收到的 `s`);连续两次没有收到 op 11 视为断线。
- 断线或 op 7:有 `session_id` 时重连并发 op 6 Resume;op 9 或 Resume 失败时丢掉 `session_id` 重新 Identify。重连之间至少隔 1 秒;连续 5 次连上却没走到 READY / RESUMED 时交给框架退避(1 秒起,最长 5 分钟)。关闭码按上表:4008 / 4009 与普通断线 Resume,4006 / 4007 / 4900–4913 重新 Identify,4013 / 4014 报 `needs-login`(`qq_intent_not_permitted`,要在开放平台开通单聊权限),4914 / 4915 报 `needs-login`(`qq_bot_unavailable`),其余 4001–4012 报 `backoff`。`stop()`(`signal`)立即关闭连接,不等心跳。
- 一次只处理一条事件:WebSocket 不能暂停读取,所以收到的消息排成一条链,`await ctx.receive(...)` 返回后才交下一条;平台重投的消息由 `channel_inbox` 去重(ADR 0022 第 8 节)。
- 只用 Node 24 自带的 `WebSocket`,不引入依赖。

### 3.3 入站映射

| 平台                                                      | `InboundMessage`                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `C2C_MESSAGE_CREATE` 的消息 `id`                          | `externalMessageId`,同时放进 `replyContext`                          |
| `author.user_openid`                                      | `externalUserId`                                                     |
| `GROUP_AT_MESSAGE_CREATE`                                 | `chat: 'group'`(框架忽略;`externalUserId` 取 `author.member_openid`) |
| `content`(去掉首尾空白)                                   | `text`                                                               |
| `msg_elements` 里的正文(引用 103、聊天记录 102,最多 4 层) | `quoted: [{ kind: 'quote' / 'forwarded', text }]`,不可信             |
| 卡片(`message_type` 3)的 `ark_data.prompt`                | `quoted: [{ kind: 'link-card', text }]`,不可信                       |
| 语音附件的 `asr_refer_text`                               | `voice.transcript`(没有文字时当作主人的话)                           |
| `timestamp`                                               | `receivedAt`(转成 UTC ISO)                                           |
| 附件(图片、文件、视频)                                    | 不下载;没有文字时框架回复「暂时只能看文字」                          |

`voiceTranscript: true`:语音用平台给的 `asr_refer_text`,本地不解码。其他事件(加好友、删好友、主动消息开关、群里加删机器人)不进模型,只记一条不含外部账号的日志。

### 3.4 发送

- `POST /v2/users/{openid}/messages`,`{ content, msg_type: 0, msg_id, msg_seq }`:`msg_id` 取 `replyContext`;同一条入站消息的多段回复(切段后最多 10 段)`msg_seq` 从 1 递增,避免被平台当成重复消息。
- 被动回复 60 分钟内、每条最多 4 次:适配器记住每条入站消息的收到时间和已用的 `msg_seq`(最多 500 条);超出窗口、次数用完或没有 `replyContext` 时不带 `msg_id`(主动消息)。平台回 304103 / 40034005 / 40034024 / 40034128(被动回复过期、次数用完、`msg_id` 无效)时改发一次主动消息。其他错误这一段发送失败:框架照旧记日志(只记渠道 id、状态码与平台错误码),一轮里后面的段不再发;任务推送把错误抛给 `channel.push`(第 1 节第 5 条)。
- `capabilities`:`{ markup: 'none', maxTextBytes: 2048, voiceTranscript: true }`。文档没写单条上限,先取 2048 字节,和微信一致。
- OpenAPI 的基地址固定为 `https://api.bot.qq.com`,不接受配置覆盖(测试经构造参数注入);请求都带 `Authorization: QQBot <access_token>`。

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

- **包级中枢单测**(ADR 0050 第 2 节承诺的):`packages/channels/src/hub/hub.test.ts`,覆盖绑定、过滤、去重、指令、`/map`、审批短码(含在 Web 处理后的「已处理」)、排队、限流、切段、降级提醒、任务推送与退避。共用替身在 `src/hub/test-harness.ts`:临时目录里的真实 SQLite、真实的 `RunManager` 与事件总线,模型换成按脚本输出的假 provider,渠道换成假适配器(比手写假的仓储和运行管理更贴近生产,也不用维护两套行为)。用例按 kind 参数化,`feat/channel-qq` 把 `qq` 加进去。`packages/channels/vitest.config.ts` 不再整体排除 `src/hub/**`,只排除替身和由 `apps/server` 的 `wechat-login.test.ts` 覆盖的 `wechat-channels.ts`(实现记录:`test/channel-hub-unit`)。
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

## 10. 实现记录(`feat/channel-qq`)

和提议版不一致或提议版没写清的地方:

- **主动消息**:提议版担心平台不再提供,核对后单聊主动消息仍然可用(每个用户每天 1000 条,用户可以关掉),所以超出被动回复的窗口或次数时改发主动消息,平台说被动回复过期时也改发一次;只有主动消息也被拒时才算失败。
- **语音**:平台给语音附件的文字(`asr_refer_text`),所以 `voiceTranscript` 为 true,和微信一致。
- **任务推送失败**:中枢的 `push()` 以前和普通回复一样只记错误,现在把发送错误抛给 `channel.push`,任务运行里能看到平台错误码(微信同样受益)。
- **脱敏**:`ChannelSecrets` 增加 `protect(value)`,QQ 的 access_token 换到后立即登记到脱敏器;`SecretStore` 增加同名方法。
- **假平台**:`packages/channels/src/qq-fake.ts`(经 `@fatcat-ai/channels/testing` 导出)用 `node:http` 实现令牌接口、网关地址、发消息和一个最小的 WebSocket 网关(握手 + 不分片的文本帧 + 关闭帧),不引入依赖;`apps/server` 的 `qq-credentials.test.ts` 也用它。
- **外连清单**:QQ 渠道列两项,`https://api.bot.qq.com`(令牌、网关地址、发消息)与 `wss://api.bot.qq.com`(网关)。

# ADR 0022 · 渠道框架:IM 适配器、主人绑定、IM 审批与不可信内容

- 状态:已采纳(M5a PR 3 `docs/m5a-contracts` 提议,#19 合并;M5a 自检 `docs/milestones/M5a-self-check.md` 对照第 5、6 节的偏离见该报告第三节);框架已在 M5a PR 5 `feat/channel-core` 实现(第 14 节),微信 iLink 见 PR 7 `feat/channel-wechat`
- 日期:2026-11-10(America/Los_Angeles)
- 相关:开发计划第 6 节(`ChannelAdapter`)、第 7 节(安全模型)、第 8 节 M5a、第 15.4 节(`/source`);ADR 0004(API v1 约定)、ADR 0006 第 2 节(密钥引用与 `secrets.yaml`)、ADR 0007(记忆的 `sensitivity` 与渠道过滤)、ADR 0010(工具与审批)、ADR 0016(不可信内容与注入评测)、ADR 0017(降级提醒)、ADR 0018 第 5 节(渠道内存增量)
- 业主决定(2026-11-11,#17 评论):企业微信推迟,M5a 只做框架与微信 iLink;所有密钥统一放在数据目录的 `secrets.yaml`;iLink 令牌写入 `secrets.yaml`(写入规则见第 9 节)

## 背景

M5a 让主人在 IM 里使用同一个助手。IM 与 Web 的差别决定了这份 ADR 要回答的问题:

- 任何人都能给机器人账号发消息,而 1.0 只有一个用户。必须先确定「谁是主人」,其他人的消息不能进模型。
- IM 没有按钮,审批只能靠回复文字;回复文字可以被转发、引用、伪造。
- 转发的聊天记录、引用的消息、链接卡片都是别人写的内容,和邮件一样可能带注入指令。
- 各平台的富文本能力不同,单条消息有长度上限。
- 平台会重投消息;长轮询断线要重连;一个渠道出错不能拖垮服务器。

## 1. 决定(摘要)

1. 渠道适配器只负责「和平台说话」;绑定、会话、审批、过滤、去重、限流、格式降级都在框架里,所有渠道共用一套,并用一个只在测试里存在的假渠道跑全部框架逻辑与评测。
2. 每个渠道最多绑定一个主人账号,用 Web 生成的一次性配对码绑定;只有主人的私聊消息进入会话,其他消息一律忽略(不回复、不进模型,只计数)。
3. IM 里的审批用每个待审批调用一个的短码:「确认 K7」/「拒绝 K7」,只认主人私聊,走和 `POST /api/v1/approvals/{callId}` 相同的代码路径与审计。
4. 主人自己打的字是用户输入;转发、引用、链接卡片的标题与摘要是不可信内容,与邮件同一套规则。
5. 1.0 的渠道只回复主人,没有「发给任意联系人」的工具。
6. 密钥一律放在 `secrets.yaml`(或环境变量),数据库只存 `env:` / `file:` 引用;运行时产生的令牌由服务器按第 9 节的规则写进 `secrets.yaml`。

## 2. 适配器接口(`packages/channels`,AGPL-3.0-only)

```ts
export interface ChannelAdapter {
  readonly kind: ChannelKind; // 1.0:'wechat';企业微信以后加入
  readonly capabilities: {
    /** 平台能显示的富文本;'none' 只发纯文本。 */
    markup: 'none' | 'markdown-subset';
    /** 单条消息的最大字节数(UTF-8)。 */
    maxTextBytes: number;
    /** 平台会不会给出语音的文字结果(M5a 不做本地语音解码,方案问题 4)。 */
    voiceTranscript: boolean;
  };
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(target: ChannelTarget, message: OutboundMessage): Promise<void>;
}

export interface ChannelContext {
  readonly channelId: string;
  /** 把一条入站消息交给框架;框架负责去重、过滤与排队,适配器不判断主人。 */
  receive(message: InboundMessage): Promise<void>;
  /** 状态变化(needs-login、backoff 等)与最近错误;不带令牌和正文。 */
  report(state: ChannelState, error?: { code: string; message: string }): void;
  /** 读取密钥引用(env: / file:),写入运行时令牌(第 9 节)。 */
  secrets: ChannelSecrets;
  log: ChannelLogger; // 只允许记 channelId、消息类型、长度、状态码
  signal: AbortSignal; // stop() 时中止长轮询
}

export interface InboundMessage {
  externalMessageId: string;
  externalUserId: string;
  chat: 'direct' | 'group';
  /** 主人自己打的字。 */
  text: string;
  /** 转发 / 引用 / 链接卡片等别人写的内容,逐段标出来源;框架按不可信内容处理(第 5 节)。 */
  quoted: { kind: 'forwarded' | 'quote' | 'link-card'; text: string }[];
  receivedAt: string; // ISO,UTC
  voice?: { transcript: string }; // 只有平台给出文字结果时才有
}

export interface ChannelTarget {
  externalUserId: string;
  /** 平台要求回复时带上的上下文(例如 iLink 的会话令牌);框架原样传回,不记日志。 */
  replyContext?: string;
}

export interface OutboundMessage {
  /** 已按 capabilities 降级并切段后的一段;框架保证不超过 maxTextBytes。 */
  text: string;
}
```

与方案草稿相比的两处变化:`forwarded: boolean` 改成 `quoted` 数组,因为一条消息可以同时有主人的话和转发的内容,框架需要把两者分开;语音只保留 `transcript`,不提供下载音频的入口(问题 4 的结论)。

## 3. 主人绑定与消息过滤

- Web「设置 → 渠道」对某个渠道生成配对码:6 位数字,10 分钟有效,一次有效;数据库只存 `sha256(channelId + ':' + code)` 与过期时间。再次生成会作废上一个码。
- 渠道里**私聊**发来「绑定 123456」(也接受 `bind 123456`,前后空白与全角数字归一):码正确且未过期 → 发送者成为这个渠道的主人,回复「已绑定」;码错误 → 回复「配对码不对」并计一次失败。同一个配对码累计失败 5 次后作废,需要在 Web 重新生成。已知的可用性风险(接受):未绑定期间,陌生人可以故意发错码把这 5 次额度用完,结果只是主人需要重新生成,码本身不会泄露;PR 5 若实现成本低,再按外部账号分别计数。已有主人时,绑定指令只能由 Web 先解除绑定后再用。
- 过滤规则(按顺序,命中即停):
  1. 群聊消息 → 忽略。
  2. 未绑定时,除绑定指令外的消息 → 忽略。
  3. 发送者不是主人 → 忽略(也不提示「这是私人助手」,方案问题 6)。
  4. 其余是主人的私聊消息,进入第 4 节。
- 「忽略」= 不回复、不进模型、不写会话、不写记忆,只给 `ignoredCount` 加 1。日志只记 channelId 与原因,不记外部 id 与正文。
- `DELETE /api/v1/channels/{id}/binding` 解除绑定:之后旧主人的消息按规则 2 忽略;会话保留。
- 群聊在 1.0 不处理,但框架给召回预留 `channel: 'group'`:群聊上下文的召回与 digest 使用 ADR 0007 已有的 `group` 过滤(只取 `sensitivity` 0),所以 `sensitivity` > 1 的记忆一定不会出现,满足开发计划「敏感度 > 1 不进群聊与 digest」。PR 5 的评测要覆盖。

## 4. 会话、指令与排队

- 每个渠道有一个当前会话(`channels.session_id`),首次收到主人消息时创建,标题为渠道的 `label`。会话在 Web 里照常可见与续写,两边是同一份记录。
- 指令(整条消息去掉首尾空白后完全匹配才算,避免误触):`/new` 开新会话并设为当前会话;`/clear`(中文别名「清空」)只删除这个渠道的当前会话,先停掉进行中的运行,并删除该会话的附件文件,记忆不删,Web 上的其他对话不动,也不需要审批短码;`/source` 回复 `GET /api/v1/meta` 的 `sourceUrl`(AGPL §13,开发计划第 15.4 节);`/help` 列出指令与审批格式;「确认 K7」/「拒绝 K7」见第 6 节。指令不进模型。用 `/new` 换下来的旧会话不再挂在渠道上,`/clear` 不会删它们。
- 同一会话正在运行时,新消息排队(每个渠道最多 5 条,多出的回复一次「上一条还没处理完」并丢弃),上一轮结束后按顺序作为新的一轮,不并发起第二轮。Web 在同一会话里发消息时同样受 runner 已有的「一个会话同时一轮」约束。
- 限流:每个渠道每分钟最多处理 20 条主人消息(滑动窗口,指令也计入);超出时本分钟内回复一次「太快了,请稍后再发」,其余静默丢弃并计入 `rateLimitedCount`。
- 回复:一轮的最终回答按第 7 节降级后发给主人;工具调用过程不推送,只推送审批请求(第 6 节)。

## 5. 不可信内容

- `InboundMessage.text`(主人打的字)是用户输入。
- `quoted` 里的每一段在交给模型前按与邮件相同的方式标为不可信内容(ADR 0010 第 7 节、ADR 0016 第 5 节),并置会话的 `untrustedContentSeen`,之后的对外发送类工具照 ADR 0016 第 7 节的会话级污染规则需要审批,并带 ADR 0016 第 8 节的审批警告。
- 不可信内容里出现的「确认 K7」不算审批:审批只从 `text` 中按第 6 节的格式识别,且整条消息只有这条指令。
- 平台的系统通知(撤回、入群、好友验证等)不进模型,适配器直接丢弃或转成状态。

## 6. IM 中的审批

- 收到 `approval-required` 时,框架给这个调用分配一个短码:1 个字母 + 1 位数字(去掉易混的 I、O、0、1),在这个渠道当前的待审批里唯一;推送「需要确认:<summary>。回复『确认 K7』或『拒绝 K7』,30 分钟内有效」(分钟数取这个审批实际的剩余时间)。`summary` 原样来自 ADR 0010 的事件,不另行拼接工具参数。
- 只认主人私聊里、整条消息为 `确认 <码>` / `拒绝 <码>`(也接受 `approve <码>` / `deny <码>`,大小写与全角归一)的回复。码不存在、已过期、属于别的渠道 → 回复「没有这个待确认项」,不做任何事。
- 通过 / 拒绝走与 `POST /api/v1/approvals/{callId}` 相同的服务函数,审计写同样的 `approval` 动作,另带 `via: 'channel'` 与 channelId。Web 上照常可以批准;任一方先处理,另一方再处理时得到「已处理」。
- 短码随审批过期而作废(过期时间沿用 ADR 0010 第 5 节);服务器重启后待审批本来就失效,短码一并失效。
- 条件预授权(ADR 0010 第 4 节)在 IM 里不提供:只有「这一次」的确认与拒绝。

## 7. 出站与富文本降级

- 主动推送只有三类:审批请求、降级提醒(ADR 0017 第 5 节的开关,`notifyDegraded`,默认关;10 分钟内 3 次降级提醒一次,恢复正常后才会再提醒)、渠道状态通知(例如「令牌失效,请在 Web 重新扫码」只发到 Web 状态,不发 IM)。
- 1.0 不提供「发 IM 给任意联系人」的工具;发邮件等对外发送照旧经工具与审批。
- 降级(`markup: 'none'`,微信 1.0):标题去掉 `#`,列表保留 `-` / `1.`,粗斜体去掉标记;代码块保留原文、去掉围栏;链接写成「文字 (网址)」;图片写成「[图片] 网址」;表格每行转成「列: 值」的行。
- 切段:超过 `maxTextBytes` 时按段落 → 行 → 字符的顺序切,不切断 UTF-8 字符与代理对;多于一段时每段末尾加「(1/3)」;一轮最多 10 段,超出的部分改成一句「完整回答请在 Web 查看」。

## 8. 可靠性

- 去重:按 `(channelId, externalMessageId)` 写 `channel_inbox`,已存在则丢弃;保留 3 天,由每日维护清理。去重在过滤之前,所以被忽略的消息也会去重。
- 适配器出错(`start` 抛错、长轮询连续失败):框架按指数退避重启(1 s 起,翻倍,最长 5 分钟,加 ±20% 抖动),状态为 `backoff`;令牌失效时为 `needs-login`,不再重试,直到重新扫码。一个渠道的错误不影响其他渠道和服务器。
- 停用 / 删除渠道:`stop()` 中止长轮询(`signal`),等待最多 5 秒;排队中的消息丢弃。
- 内存:入站消息不在内存里堆积(长轮询一次只取平台给的一批,处理完再取下一批);排队上限见第 4 节。增量测量按 ADR 0018 第 5 节,在 PR 8 做。

## 9. 密钥(业主 2026-11-11 决定)

- 所有密钥统一放在数据目录的 `secrets.yaml`(ADR 0006 第 2 节的扁平格式),或由环境变量提供;数据库与 API 只出现 `env:NAME` / `file:NAME` 引用,API 响应里连引用也不返回。M5b 的加密存储会整体加密这个文件。
- 运行时产生的令牌(iLink 扫码后拿到的令牌)由服务器写进 `secrets.yaml`,键名 `ILINK_TOKEN_<channelId>`,渠道配置里记 `file:ILINK_TOKEN_<channelId>`。写入必须满足:
  1. **先备份**:把当前文件复制到数据目录的 `backups/secrets-<UTC 时间戳>.yaml`(权限 600;只保留最近 5 份);文件不存在时不备份。
  2. **只改目标键**:按行处理;目标键已存在时只替换那一行的值,不存在时追加到文件末尾;其他行(键、注释、空行、顺序、换行符风格)逐字节不变。
  3. **解析失败不写**:先用 `parseSecretsFile` 解析现有内容,失败则报错(`secrets_write_failed`)并停止,原文件不动、不清空、不覆盖。
  4. 写临时文件(同目录,权限 600)后原子改名替换。Windows 上 `mode 600` 不改变 ACL,所以写完 `secrets.yaml` 和当次备份后,用 `icacls` 去掉继承的 ACE,只给当前用户完全控制。参数是路径、`/inheritance:r`、`/grant:r`、以及「当前用户名:F」,以参数数组传给 `execFileSync`(`shell: false`,不经过 shell;用户名取 `USERNAME` 环境变量,不在命令行里展开百分号变量)。`icacls` 失败或没有 `USERNAME` 时只记一条警告(不含密钥),文件保留,写入本身仍然成功。非 Windows 不调用 `icacls`。
  5. 删除渠道时只删除这个键(同样先备份、只改这一行)。
- 令牌、`replyContext`、消息正文、外部账号 id 都不进日志;值在读取时登记到脱敏器(与模型密钥相同)。
- 测试(PR 7):备份文件存在且内容等于原文件;其他键 / 注释 / 顺序不变;已有键更新只改一行;解析失败时文件字节不变且报错;CRLF 文件保持 CRLF。

## 10. 存储(迁移 0014,PR 5)

| 表                 | 字段                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`         | `id`、`owner_id`、`kind`、`label`、`enabled`、`session_id`(可空,外键到会话,删会话时置空)、`notify_degraded`、`config_json`(只含引用)、时间戳 |
| `channel_bindings` | `channel_id`(主键,级联删除)、`external_user_id`、`bound_at`                                                                                  |
| `channel_pairings` | `channel_id`(主键,级联删除)、`code_hash`、`expires_at`、`failed_attempts`                                                                    |
| `channel_inbox`    | `channel_id`、`external_message_id`(联合主键)、`received_at`;3 天后清理                                                                      |

状态计数(`ignoredCount` 等)只在内存里,不落库。

## 11. API(`/api/v1`,都需要登录并按 `ownerId` 取数据)

| 方法与路径                            | 说明                                                |
| ------------------------------------- | --------------------------------------------------- |
| `GET /channels`                       | 列表,`Channel[]`(不分页,1.0 渠道数很少)             |
| `POST /channels`                      | `ChannelCreate` → `Channel`,新建默认停用            |
| `GET / PATCH / DELETE /channels/{id}` | `ChannelPatch` 只改 label、enabled、notifyDegraded  |
| `POST /channels/{id}/pairing`         | → `ChannelPairing`,明文码只在这个响应里出现一次     |
| `DELETE /channels/{id}/binding`       | 解除绑定                                            |
| `GET /channels/{id}/status`           | → `ChannelStatus`                                   |
| `POST /channels/{id}/wechat/login`    | 开始扫码,→ `WechatLoginStart`;只对 `kind: 'wechat'` |
| `GET /channels/{id}/wechat/login`     | 轮询扫码状态,→ `WechatLoginState`                   |

- 别人的渠道一律 404(不暴露存在与否);未登录 401;对非 wechat 渠道调用 `wechat/login` 返回 409。
- `GET /api/v1/meta` 的 `capabilities` 在渠道接口实现后(PR 5)增加 `channels`。
- 契约(zod)在 `packages/shared/src/channels.ts`,本 PR 只新增 schema,不注册路由,OpenAPI 不变;路由随 PR 5 / 7 加入,都是新增路径。
- 企业微信推迟后,原方案里不需要登录的 `wecom/callback` 不在 1.0 的这批接口里;以后加入时另写 ADR 修订本节,并带上方案第 3 节的「先验签再解密」清单。

## 12. 评测与测试(PR 5、PR 7)

- `apps/server/src/channel-injection.eval.test.ts` 用假渠道跑方案 PR 5 列出的 15 条用例;企业微信相关的「回调验签」不在其中。每条都要证明:触发不了对外发送、绕不过审批、非主人的内容不进模型。
- 越权:其他用户的渠道、未登录调用渠道接口、对非 wechat 渠道调用扫码接口。
- 假 iLink 服务器(PR 7):长轮询、超时、令牌失效、重复消息、断线重连;不连真实微信。

## 13. 微信 iLink 的资料来源(净室)

业主没有自己的桥接项目(开发计划原写「业主已有的 wechat-ilink 桥接项目」,已更正)。PR 7 只读以下两个第三方 MIT 项目的 README 和公开的协议说明(扫码授权、长轮询、发消息的接口与字段),**不读、不复制源代码**:

- 腾讯微信官方 npm 包 `@tencent-weixin/openclaw-weixin`(优先);
- `gfydfhcf/wechat-ilink-muse-bridge`。

公开文档不足以实现时,在 PR 7 里列出缺少的接口细节,等业主决定,不去看代码。

## 14. 实现记录(PR 5 `feat/channel-core`)

与上文不一致或上文没写清的地方,按下面的做法实现;需要业主确认的列在 PR 描述里。

- 代码位置:接口、指令解析、降级与切段、短码分配、限流与退避在 `packages/channels`;假渠道在子路径 `@fatcat-ai/channels/testing`,服务器的生产代码不引用它。绑定、会话、审批与排队的编排在 `apps/server/src/channels/hub.ts`(需要存储与 runner)。
- `InboundMessage` 增加可选的 `replyContext`(第 2 节 `ChannelTarget.replyContext` 的来源),框架原样带回,不记日志。`ChannelSecrets` 先只有 `resolve`,写入运行时令牌随 PR 7。
- `GET /channels` 返回与 `/tools`、`/mcp/servers` 一致的 `{ items, nextCursor: null }`(不分页)。已绑定时 `POST /channels/{id}/pairing` 返回 409(`conflict`)。
- 审计:IM 审批调用 `RunManager.resolveApproval` 的同一个函数,多一个 `via` 参数;工具调用那条审计的 `summary` 末尾加「(via channel <渠道 id>)」。没有给 `AuditEntry` 加字段(需要改已有 schema 与迁移),以后需要按渠道筛选时再加。
- 不可信内容:`quoted` 的每一段以 `{"untrusted":true,"kind":…,"content":…}` 的形式接在主人的话之后,前面一句说明;同时在开始这一轮之前置会话的 `untrustedAt`,runner 读到后条件预授权失效。
- 配对码失败次数按渠道累计(没有按外部账号分别计数);没有配对码或已过期时回复「配对码不对」,不计数。
- 语音:适配器给出 `voice.transcript` 且没有文字时用它作为主人的话;都没有时回复「暂时只能看文字,请发文字消息」。
- 排队:入站处理不等这一轮结束(否则等待审批时收不到「确认 K7」);Web 正在同一会话里运行时,IM 的这一轮等它结束再开始(最多重试 3 次)。
- 退避:`start` 抛错或适配器报告 `backoff` / `error` 时都按第 8 节退避重启,不会停止重试;`error` 只用于「这个类型没有注册适配器」(`adapter_unavailable`,PR 7 之前的微信渠道就是这样)。
- 降级提醒只统计这个渠道当前会话里的运行;一轮正常结束(没有降级)即算恢复。
- 一定会被忽略的消息(群聊、未绑定时的非绑定指令、非主人)每个渠道每分钟最多写 120 条去重记录,超出的只给 `ignoredCount` 加 1,不落库,避免陌生人刷消息撑大 `channel_inbox`。
- 一轮进行中在 Web 解除或更换了绑定时,这一轮的回答不发出(发送前再读一次绑定)。
- 去重记录由每天的定时任务(与记忆维护同一时间,按用户时区)清理 3 天前的行。
- 实现备注(M5b PR 2 `fix/channel-approval-gaps`,契约不变,补充第 3、5、6 节;`apps/server/src/channels/hub.ts`):
  契约不变,下面是对第 3、5、6 节和第 14 节的实现补充(`apps/server/src/channels/hub.ts`):
  - **审批提醒带警告**:`approval-required` 事件有 `warnings` 时,每条 `message` 单独一行「注意:…」附在摘要之后、「回复…」一句之前;没有警告时文案逐字不变。超过适配器单条上限时只截断警告(必要时退成固定的一行「有安全警告,请在 Web 查看」),「回复『确认 K7』或『拒绝 K7』,N 分钟内有效。」一句保持完整。
  - **已处理的短码**:`Runtime.handled` 记录「在别处处理的短码 → 原审批过期时间」,只存在进程内存里;收到 `approval-resolved` 时从 `codes` 移入,到期或解除绑定、停用渠道时清除;分配新短码时同时避开 `codes` 与 `handled`。IM 回复:在 `codes` 里 → 走 `resolveApproval`;在 `handled` 里 → 「已处理。」;其余(不存在、过期、别的渠道、重启后)一律「没有这个待确认项。」,不泄漏其他渠道的审批状态。
  - **带引用的消息**:`quoted` 非空时,正文即使整条是「确认 K7」/「拒绝 K7」也不解析为审批,按普通主人消息进入会话并置 `untrustedAt`。其他指令(`/new` 等)不受影响。
  - **未绑定时的「绑定 ######」**(取代第 3 节「码错误 → 回复『配对码不对』」与第 14 节「没有配对码或已过期时回复『配对码不对』」):码错误(含没有配对码、已过期、已锁定)不回复,按「忽略」处理——计入每分钟 120 条的忽略类上限(超出只计数、不落库),日志只记渠道 id 与原因 `bad-code`;失败次数仍计入配对码的 5 次锁定,超过 120 条上限的错误码同样计入锁定,不能借洪水绕过;只有没有配对码或已过期时不计数。码正确时回「已绑定。」。副作用:主人手误输错码时微信里没有反馈,只能在 Web「渠道」页重新生成配对码。
- 实现备注(M5b PR 2b `fix/mail-quoted-recipients`,契约不变,补充第 5 节;`packages/tools/src/untrusted-blocks.ts`):`mail.send` 判断收件人是否可信(ADR 0016 第 7 节)时,只取主人自己写的文字:先剥离渠道拼进用户消息的不可信块(引导句和每行 `{"untrusted":true,…}`)再收集地址。拼装与剥离是同一处定义的一对纯函数,`composeUserText` 与 `untrustedRecipients` 共用;每个块必为单行(JSON 转义外再转义 `U+0085`、`U+2028`、`U+2029`)。宁严勿松:主人正文里自己写出形似块的行也一并剥离,最多多出警告。历史会话在读取时同样适用,不改数据。审批提醒因长度整条丢掉 N(>0)条警告时,在「回复…」一句前加一行「还有 N 条警告,请在 Web 查看。」(被截断但仍显示一部分的那一条不计入 N)。

## 后果

- 框架与平台分开,企业微信以后只需加一个适配器与 `ChannelKind` 的新值(OpenAPI 只增)。
- IM 里能做的事比 Web 少(没有条件预授权、没有群聊),这是有意的:IM 的身份与输入都更容易伪造。
- 往 `secrets.yaml` 写入是服务器第一次修改数据目录里用户手写的文件;第 9 节的规则与测试是这项改动的前提,M5b 加密时整体迁移。

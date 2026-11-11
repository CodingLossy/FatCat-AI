# ADR 0024 · 微信 iLink 适配器

- 状态:提议(M5a PR 7 `feat/channel-wechat`)
- 日期:2026-11-11(America/Los_Angeles)
- 相关:ADR 0022(渠道框架,第 9 节密钥写入、第 13 节资料来源)、ADR 0006 第 2 节(`secrets.yaml`)、ADR 0018 第 5 节(渠道内存增量,PR 8)

## 0. 资料来源(净室)

只依据腾讯公开的两份文档:npm 包 `@tencent-weixin/openclaw-weixin` 2.4.10(MIT)的 `README.md`,以及同一仓库公开的 `docs/protocol.md`(Weixin Backend API Protocol)。下载 npm 包时只解出 `*.md`,没有解出、打开或搜索任何源代码;`gfydfhcf/wechat-ilink-muse-bridge` 在本会话无法访问,没有读。

## 1. 决定

1. **只做 1.0 需要的四个接口**:`POST /ilink/bot/get_bot_qrcode?bot_type=3`(自己绑定,body 只有空的 `local_token_list`)、`GET /ilink/bot/get_qrcode_status`(长轮询)、`POST /ilink/bot/getupdates`(长轮询收消息,游标 `get_updates_buf`)、`POST /ilink/bot/sendmessage`(文本 `item_list[{type:1,text_item}]`,带入站的 `context_token`)。不做:媒体上传下载(CDN、AES)、输入状态、`notifyStart/Stop`、实名代绑(`botrealnameverifycgi`)、扫码时的 PIN(`need_verifycode`,遇到时登录失败,原因码 `verify_code_required`)。
2. **请求头**按协议说明:`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <令牌>`(扫码接口不带)、`X-WECHAT-UIN`(随机 uint32 的十进制再 base64)、`iLink-App-Id: bot`、`iLink-App-ClientVersion`;`base_info.channel_version` 为 `2.4.10/fatcat-ai`,`bot_agent` 为 `FatCat-AI/0.1`(待业主决定的问题)。
3. **入站映射**:`message_type` 为 2(机器人自己)丢弃;`message_id`(没有时 `client_id` / `seq`)作为去重 id;`from_user_id` 为外部账号;有 `group_id` 为群聊(框架忽略);`text_item` 是主人的话,`voice_item.text` 作为语音转写;任何条目上的 `ref_msg` 作为 `quoted: quote`(不可信);`context_token` 放进 `replyContext`。图片、文件、视频没有文字,框架回复「暂时只能看文字」。
4. **长轮询与重连**:一批消息逐条 `await ctx.receive` 处理完才前移游标并取下一批,内存里不堆积消息;本地超时 = 平台建议的 `longpolling_timeout_ms`(默认 35 秒,上限 120 秒)+ 10 秒,超时按空批继续。平台立刻返回时,两次请求之间至少隔 1 秒,这段等待可以被停止或关机打断,不必等满 1 秒。HTTP / 网络错误报告 `backoff`,由框架按 ADR 0022 第 8 节指数退避(最长 5 分钟)重启;`ret` 或 `errcode` 为 `-14`(会话失效)报告 `needs-login`,不再重试,直到重新扫码。游标保存在服务器进程内(按渠道),重启适配器后接着收;服务器重启后从空游标开始,重投的消息由 `channel_inbox` 去重。
5. **扫码授权**(`POST/GET /api/v1/channels/{id}/wechat/login`):POST 向默认地址 `https://ilinkai.weixin.qq.com` 请求二维码,返回 `qrContent`(`qrcode_img_content`,由 Web 自己渲染成二维码)与 5 分钟的 `expiresAt`;服务器在后台轮询扫码状态,GET 立即返回当前状态(`pending` / `scanned` / `confirmed` / `expired` / `failed` + `code`)。平台立刻返回 `wait` 或 `scaned` 时,两次查询之间至少隔 1 秒,这段等待在取消登录、删除渠道或进程退出时立刻结束。同一渠道再 POST 会作废上一次。`scaned_but_redirect` 的 `redirect_host` 与 `confirmed` 的 `baseurl` 只接受 `https://*.qq.com`(不带用户名密码),否则失败(`unexpected_host`),防止扫码结果把令牌引到别处。
6. **令牌**:`confirmed` 后按 ADR 0022 第 9 节把 `bot_token` 写进 `secrets.yaml` 的 `ILINK_TOKEN_<channelId>`(先备份到 `backups/secrets-<UTC>.yaml`,只留 5 份;只改这一行;解析失败报 `secrets_write_failed`,文件不动;临时文件 + 原子改名,权限 600),渠道配置记 `tokenRef: file:ILINK_TOKEN_<channelId>` 与 `baseUrl`(只存来源,不是密钥),然后按新令牌重启渠道。令牌写入前先登记到脱敏器。删除渠道时同样先备份、只删这一行;删除失败只记日志(原因码),渠道照常删除。
7. **单条长度**:公开文档没有写上限,`maxTextBytes` 先取 2048 字节(框架按段落切段,带「(1/3)」)。

## 2. 测试

- `packages/channels/src/wechat.test.ts`:本机 HTTP 假 iLink 服务器,覆盖长轮询与游标、请求头、重复消息原样交给框架、`-14` → needs-login、HTTP 502 → backoff、本地超时与 `stop()` 立即中止、发文本带 `context_token`、扫码接口;入站映射(群聊、引用、语音、机器人消息)。
- `packages/providers/src/secrets-write.test.ts`:ADR 0022 第 9 节列出的全部写入规则。
- `apps/server/src/wechat-login.test.ts`:扫码 → 令牌写入且备份等于原文件 → 用令牌长轮询 → API 与日志里没有令牌 → 删除渠道后文件恢复原样;解析失败时不写;过期与 PIN;未登录 401、不存在 404。

## 后果

- 真实微信的行为(二维码内容的格式、单条上限、令牌有效期、是否要求特定 `channel_version`)只能由业主在真机上确认,清单在 PR 描述里。
- 不做 PIN 与实名代绑:扫码账号需要 PIN 时 1.0 无法登录,需要时再加。

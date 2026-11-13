# M5b 实施方案:渠道审批缺口、密钥加密、TOTP、外连清单、知识地图分类浏览器与人物

- 状态:提议(PR 1,纯文档;合并后才开始写代码)
- 日期:2026-11-12(America/Los_Angeles,业主所在时区;M5b 文档的日期都按这个时区写)
- 基线:`main` @ `f54d489`(M5a 的 PR 8 `ci/channel-memory` 已合并为 #27)
- 依据:开发计划 M5b 一节(第 8 节)、4.1.1(知识地图分类浏览器)、6.2(条目表与层级查询 API)、第 7 节(安全模型)、第 10 节(零遥测);`docs/milestones/M5a-self-check.md` 第三、五节(审批偏离与带入 M5b 的遗留项);ADR 0003、0006(密钥引用)、0012(条目 API)、0016(邮件与审批警告)、0018(内存预算)、0022(渠道)、0025(知识地图计数)
- 范围控制:沿用前几个里程碑的做法,先契约后实现;高风险的 PR(数据目录、`secrets.yaml`、迁移、登录)要等业主明确同意才合并(第 2 节各 PR 的「风险」一行);界面保持够用,不做的内容列在第 6 节
- 本 PR 不改 `packages/`、`apps/` 下任何文件,不加迁移,不动开发计划第 16 节已定决策。下文提到的迁移、ADR 编号、接口路径都是方案,以各 PR 的 ADR 定稿为准

## 0. 范围

M5b 让这个助手可以放心地暴露到公网之前的几件事都有着落:渠道审批的几处缺口补齐,密钥不再以明文放在数据目录,登录可以加第二因素,设置页能列出全部外连目标,知识地图从只读列表变成完整的分类浏览器(含人物),微信里能用 `/map` 在知识地图里下钻。

在 M5b:

1. 渠道审批缺口修复(M5a 自检报告第三、五节)。
2. 契约 PR:密钥加密存储、TOTP、外连目标清单 API、`/map` 指令、`characters` 提供者与邮件联系人的非 primary 边的 ADR 与 `packages/shared` 增量。
3. 密钥加密存储(含 iLink 令牌迁移、主密钥来源、备份策略)。
4. TOTP 两步验证。
5. 设置页外连目标清单(零遥测落地)。
6. `characters` 提供者与邮件联系人。
7. `CategoryBrowser` 完整版(懒加载树、虚拟滚动、面包屑、计数徽标、详情的「打开」与「问 AI」、子树内搜索、手机响应式)。
8. IM 的 `/map` 指令。
9. M5b 自检报告。

不在 M5b:粒子球导航 `KnowledgeSphere`(M10,第 16 节);企业微信(M5a 推迟,排期另定);CodeQL / Semgrep、部署文档、发布(M5c);定时推送到渠道(M6);多用户。完整的推迟项见第 6 节。

渠道内存增量(M5a 的 PR 8)已由 #27 完成,不再带入 M5b。

### 当前代码状态(决定了从哪里起步)

- **渠道审批**(`apps/server/src/channels/hub.ts`):`onEvent` 推送审批提醒时只用 `event.summary`,没有读取 `approval-required` 事件上的可选 `warnings`(ADR 0016 第 8 节);`approve()` 在短码不在 `rt.codes` 时一律回「没有这个待确认项。」,Web 先处理后短码已被清掉,IM 再回同一个短码得到的也是这句;`receive()` 对文本直接 `parseCommand`,带引用(`quoted` 非空)的消息正文是「确认 K7」时同样会走审批;未绑定时任何人发「绑定 ######」都会走 `bind()`,码错误时回 `badCode`,而且这类消息没有进入「忽略类」每分钟 120 条上限(`IGNORED_MESSAGES_PER_MINUTE`)。
- **密钥**:模型配置档、邮件账户、渠道只保存 `env:` / `file:` 引用;`file:` 指向数据目录的 `secrets.yaml`(明文、权限 600,Windows 上限制为当前用户;读取在 `packages/providers/src/secrets.ts` 的 `SecretStore`)。微信 iLink 令牌在扫码后由服务器写入 `secrets.yaml`(`apps/server/src/channels/wechat.ts`;先备份到 `backups/`、保留 5 份、只改目标键、解析失败不写,ADR 0022 第 9 节)。没有加密,没有主密钥。
- **登录**:有管理员账户、HttpOnly Cookie 会话、可吊销的个人访问令牌与登录失败限流(`apps/server/src/routes/auth.ts`、`apps/server/src/auth/`);代码里没有 TOTP。
- **外连**:设置页没有外连目标清单。代码里没有更新检查(`grep` 未发现),开发计划第 10 节提到的「用户可关闭的更新检查」目前不存在。
- **知识地图**:`/api/v1/items` 已有 `roots`、`{id}`、`children`、`ancestors`、`counts`、`subtree`、`content`、`search`(含 `under`)、`changes`、`sync`(ADR 0012);`contentCount` 由 ADR 0025 加入。**还没有**:`/items/{id}/related`、`POST /items/{id}/ask`、ETag / `If-None-Match`(ADR 0012 第 2 节明确留到 M5)。Web 的 `apps/web/src/ItemsPage.tsx` 是 M2 的简单页(展开、打开、邮件上的「问 AI」),没有虚拟滚动、面包屑、子树内搜索与手机布局;`packages/ui` 目前只有 `voice-orb`。
- **人物**:没有 `characters` 提供者,条目索引里没有「人物」根节点(M3 的 `docs/milestones/M3-self-check.md` 与 ADR 0016 第 1 段已把联系人整块推迟到 M5)。邮件同步已有 `mail.message` 条目(ADR 0025:同一封邮件在每个所在文件夹各有一条)。
- **`/map`**:`packages/channels/src/commands.ts` 的已有 `/new`、`/clear`、`/source`、`/help` 与绑定、审批指令,没有 `/map`。
- **迁移**:最新是 `0014_channels.ts`;下一个编号是 0015。
- **内存**:空闲 RSS 约 110 MiB(基线 111,上限 250);微信渠道增量 +14.1 MiB、上限 25 MiB(ADR 0018 第 5 节,#27)。新增依赖先测内存(ADR 0018)。

## 1. PR 顺序

| #   | 分支                         | 范围(摘要)                                                            | 风险                 | 依赖    |
| --- | ---------------------------- | --------------------------------------------------------------------- | -------------------- | ------- |
| 1   | `docs/m5b-plan`              | 本方案;顺带更新 M5a 自检报告与方案里 PR 8 的状态(#27)                 | 低                   | —       |
| 2   | `fix/channel-approval-gaps`  | 渠道审批四处缺口(警告、已处理、引用消息、陌生人错误绑定码)            | 高(审批)             | 1       |
| 2b  | `fix/mail-quoted-recipients` | 引用块里的地址不算可信收件人;警告被丢弃时给出提示                     | 高(审批、发信)       | 2       |
| 3   | `docs/m5b-contracts`         | ADR 0026–0029;`packages/shared` 与 OpenAPI 的新增部分                 | 低                   | 1       |
| 4   | `feat/secrets-encryption`    | `secrets.yaml` 整体加密、主密钥、iLink 令牌写入路径统一、迁移与备份   | **高(数据目录)**     | 3       |
| 5   | `feat/totp`                  | TOTP 登录第二因素、恢复码、迁移 0015                                  | **高(登录、迁移)**   | 3、4    |
| 6   | `feat/egress-targets`        | `GET /settings/egress-targets`、设置页清单、与实际外连一致的检查      | 中                   | 3       |
| 7   | `feat/people-provider`       | `characters` 提供者、邮件联系人、非 primary 边、`/items/{id}/related` | 中(邮件、内存与性能) | 3       |
| 8   | `feat/category-browser`      | `CategoryBrowser` 完整版、`POST /items/{id}/ask`、ETag                | 中(界面、不可信内容) | 3、7    |
| 9   | `feat/channel-map`           | IM `/map` 指令;文档、CHANGELOG(中英)、M5b 自检报告                    | 中(渠道输出)         | 2、3、8 |

数量:10 个(原 9 个加 PR 2b;2b 是 #29 合并后发现引用块地址被当作可信收件人才插入的),仍在上限内。自检报告并入最后一个功能 PR(第 5 节问题 11),所以没有单独的收尾 PR。

顺序理由:

- 2 最先做代码:它修的是已合并功能的安全缺口,范围小、不依赖任何契约(ADR 0016 第 8 节与 ADR 0022 第 5、6 节已经决定了行为)。
- 3 在所有改 `packages/shared` 的 PR 之前,按仓库约定先契约后实现。2 不改 shared,所以可以排在 3 之前。
- 4 在 5 之前:TOTP 的密钥要用 4 的主密钥加密,不先做加密就得做两套存储。
- 5 排在 4 之后,但与 6、7 互不依赖;6、7、8 可以在 4、5 等待业主同意期间继续做(同一时间只开一个功能 PR 的规则不变:一个合并或被搁置后再开下一个,见 CLAUDE.md)。
- 7 在 8 之前:浏览器要能下钻到「人物」才算完成验收项 1。
- 9 在 8 之后:`/map` 复用 8 的 `ask` 与 `related` 约定;自检要覆盖前面所有的 PR。

## 2. 各 PR 的范围与验收

每个 PR 的「ADR / 迁移 / 风险」三项按 CLAUDE.md 的自测分级:低风险跑 lint、typecheck、受影响包的测试;高风险另写手工验证步骤并标出需要 Windows 实测的部分。

### PR 1 · `docs/m5b-plan`

- 目标文件:新增 `docs/milestones/M5b-plan.md`;修改 `docs/milestones/M5a-self-check.md`(PR 8 一行、第二节最后一行、第四节表格、第五节第 2 项改为「已由 #27 完成」,数字只引用 #27 与 ADR 0018 第 5 节已有的值:增量 +14.1 MiB、上限 25 MiB)和 `docs/milestones/M5a-plan.md`(第 1 节末尾 PR 8 状态)。
- ADR:不需要。迁移:无。风险:低(纯文档)。
- 验收:`pnpm format:check`、`pnpm check:placeholders`、`node scripts/check-commit-identity.mjs` 通过;CI 全绿。

### PR 2 · `fix/channel-approval-gaps`

- 目标文件:`apps/server/src/channels/hub.ts`;`apps/server/src/channel-injection.eval.test.ts`(新增用例 16–19);必要时 `packages/channels/src/commands.ts`(给引用消息一个「不解析审批」的入口)与 `packages/channels/src/channels.test.ts`。
- ADR:不需要(行为已由 ADR 0016 第 8 节、ADR 0022 第 5、6 节决定;PR 里在 ADR 0022 第 14 节追加一条实现备注,不改契约)。迁移:无。API 与 shared:不动。
- 风险:**高(审批)**。不涉及数据目录与迁移,所以不需要额外的「明确同意」,但 PR 描述要写手工验证步骤(假渠道里走一遍:带警告的邮件审批提醒、Web 先批、引用消息、陌生人绑定)。真实微信的复测项列清单,不自己做。
- 内容(每条都要有越权或回归用例):
  - **a. 审批提醒带上警告**:`onEvent` 在 `approval-required` 事件有 `warnings` 时,把每条 `warning.message` 附在提醒里(例如「注意:…」一行一条),没有警告时文案与现在完全一致。`message` 来自 core,不含模型或邮件提供的文字(ADR 0016 第 8 节),仍按单条消息上限处理(过长时截断警告而不是截断「回复『确认 K7』」那一句)。用例 16:邮件发送的审批带 `recipient_untrusted` 警告,IM 提醒里能看到;无警告的审批提醒不变(回归)。
  - **b. Web 先处理后,IM 再回得到「已处理。」**:`Runtime` 里除了 `codes` 另记「已处理的短码」(进程内存,到原审批过期为止;分配新短码时避开这些码)。`approve()`:短码在 `codes` 里 → 走 `resolveApproval`;在「已处理」里 → 回 `alreadyHandled`;都不在 → 「没有这个待确认项。」。别的渠道的短码、已过期的短码、重启后的短码仍然是「没有这个待确认项」(不泄漏其他渠道的审批状态)。用例 17:Web 批准后 IM 回短码 → 「已处理。」且不再次执行;另一渠道的短码 → 「没有这个待确认项」(越权);过期后 → 「没有这个待确认项」。
  - **c. 带引用的消息不算审批**:`quoted` 非空时,正文即使整条是「确认 K7」或「拒绝 K7」也不当审批指令处理(同样不当 `/new` 等其他指令之外的审批),按普通主人消息进入会话,并照旧置 `untrustedContentSeen`。用例 18:主人引用了一条含「确认 K7」的消息、正文也是「确认 K7」时,待审批的调用仍然 pending(越权);不带引用时仍可批准(回归)。
  - **d. 未绑定时陌生人发「绑定 ######」**:码错误时是否回复、是否计入每分钟 120 条上限——见第 5 节问题 1。方案按推荐实现:码错误(含没有配对码、已过期、已被锁定)**不回复**,并计入「忽略类」上限(与 M5a 问题 6「非主人不回复」一致);码正确时回「已绑定。」。失败次数仍按 ADR 0022 第 14 节计入配对码的 5 次锁定。用例 19:陌生人连发错误码,没有任何出站消息、超过 120 条后只计数、第 5 次失败后正确码也失效需在 Web 重新生成(回归);正确码绑定成功(回归)。
- 验收:新增的 4 组用例通过;原有 15 条注入评测不变地通过;`pnpm --filter @fatcat-ai/server test` 中渠道相关文件通过;越权用例覆盖 b、c、d。

### PR 2b · `fix/mail-quoted-recipients`

- 起因:#29 之后发现,`mail.send` 的收件人可信性检查(`packages/mail/src/tools.ts` 的 `untrustedRecipients`)读主人的用户消息原文,而渠道把转发 / 引用内容拼在同一条用户消息里,于是别人写的地址被当成「主人自己写的」,`recipient_untrusted` 警告被绕过。
- 目标文件:`packages/tools/src/untrusted-blocks.ts`(拼装与剥离成对定义,mail 与 server 都已依赖该包,无循环依赖;不动 `packages/shared`);`packages/mail/src/tools.ts`;`apps/server/src/channels/hub.ts`(`composeUserText` 改用同一个拼装函数;`approvalReminder`);`apps/server/src/channel-injection.eval.test.ts`(新增用例 20、21)及对应单测。
- ADR:不需要(ADR 0016 第 7、8 节与 ADR 0022 第 5 节已决定行为;在 ADR 0022 第 14 节追加实现备注)。迁移、API、shared:不动;历史会话不修补,剥离在读取时进行。
- 风险:**高(审批、发信)**。真实微信的复测只列清单。
- 内容:
  - **a. 可信地址只取自主人写的文字**:收集地址前先剥离引导句与所有形似 `{"untrusted":true,…}` 的行;每个块一定只占一行(`U+0085`、`U+2028`、`U+2029` 转义),内容靠换行或引号逃不出去。被回复邮件的 From / Reply-To 与主人正文里的地址仍可信。
  - **b. 宁严勿松**:主人正文里自己写的、形似块的行同样被剥离,最多多一条警告。
  - **c. 提醒不吞警告**:因长度整条丢掉 N(>0)条警告时,在「回复…」一句之前加一行「还有 N 条警告,请在 Web 查看。」;两者都不截断。没有丢弃时文案逐字不变。
- 用例 20(收件人可信性,含越权与伪造块边界)、21(警告截断提示);原有用例 1–19 的断言不变。

### PR 3 · `docs/m5b-contracts`

- 目标文件:新增 `docs/adr/0026-secrets-encryption.md`、`docs/adr/0027-totp.md`、`docs/adr/0028-egress-targets.md`、`docs/adr/0029-knowledge-map-browser-people-map.md`(编号以合并时为准);修改 `packages/shared`(新增 schema,不改已有):`auth.ts`(TOTP 的请求与响应)、`settings.ts` 或新文件(外连目标)、`items.ts`(`related`、`ask`)、`channels.ts`(如 `/map` 需要状态字段);`apps/server/openapi/v1.json` 只增不改。
- ADR 需要:是(本 PR 就是写它们)。迁移:无(只写设计,不建表)。风险:低(文档与只增不改的 schema;`openapi-compat` 检查必须通过)。
- 各 ADR 的要点(细节在 ADR 里定,以下是需要在 ADR 里回答的问题):
  - **ADR 0026 · 密钥加密存储**:
    - 范围:`secrets.yaml` 整体加密(模型密钥、iLink 令牌、将来各渠道的密钥,业主 2026-11-11 的决定);数据库里仍然只存引用,TOTP 的共享密钥(PR 5)也用同一主密钥加密后再入库。
    - 算法与格式:`node:crypto` 的 AES-256-GCM,信封带版本号、随机 nonce、认证标签;不引入加密依赖。
    - **主密钥来源**(问题 2):按优先级 环境变量 `FATCAT_MASTER_KEY` → `FATCAT_MASTER_KEY_FILE` → 数据目录里首次启动自动生成的 `master.key`(权限 600,Windows 限制为当前用户,复用 `restrictToCurrentUser`)。写清楚它防什么、不防什么:防备份、误分享、只拿到 `secrets` 文件的泄露;不防拿到整个数据目录(含 `master.key`)的人,文档建议对公网部署把主密钥放在环境变量或容器的 secret 里。
    - **iLink 令牌迁移**:令牌现在写进 `secrets.yaml`(`wechat.ts`)。加密之后写入统一经 `SecretStore`(M5a 自检第五节第 5 项:推荐不给 `ChannelSecrets` 加写方法,适配器不能写密钥文件);保持「先备份、只改目标键、解析失败不写」的规则。
    - **迁移**(明文 `secrets.yaml` → 加密文件):显式触发(问题 3);步骤:备份 → 加密写新文件 → 解密回读并逐键比对 → 通过后才处理明文;任何一步失败都保留明文并报错。明文和已有明文备份如何处理(删除还是一并加密)是需要业主同意的数据目录改动。
    - **备份策略**(问题 4):沿用 `backups/`、保留 5 份,备份内容改为密文;主密钥**不进**自动备份;丢失主密钥等于丢失全部密钥(模型 key 重新填,iLink 令牌重新扫码),设置页显示主密钥的指纹(哈希前 8 位,不是密钥本身)方便核对。
    - **兼容**:`env:` 引用不变;同时存在明文与加密文件时启动报错而不是猜;主密钥丢失或不匹配时服务器照常启动,只是依赖密钥的功能报「密钥不可用」,不清空、不覆盖。
    - **轮换**:提供重新加密的命令(换主密钥)。
  - **ADR 0027 · TOTP**:RFC 6238(SHA-1、30 秒、6 位、前后各 1 个步长),自己用 `node:crypto` 实现,不加依赖;启用要输入当前密码 + 一次验证码(扫码页复用 `apps/web/src/QrCode.tsx`);登录流程变成「密码通过 → 临时凭证 → 验证码 → 会话」,临时凭证 5 分钟、不能当会话用;按用户与按 IP 的失败限流(复用 `FailureLimiter`);同一时间步长的验证码只能用一次(记录最后使用的步长);10 个一次性恢复码(只存哈希);关闭 TOTP 要密码 + 验证码;丢失验证码与恢复码的离线重置办法(问题 5);个人访问令牌不受 TOTP 约束,但创建令牌必须在通过第二因素的会话里(问题 5)。
  - **ADR 0028 · 外连目标清单**:`GET /api/v1/settings/egress-targets` 的响应:每项 `id`、`category`(`model` / `embedding` / `voice` / `mail` / `channel` / `mcp` / `plugin` / `update-check`)、`label`、`origin`(只到协议 + 主机 + 端口,不含路径、查询、凭据)、`source`(来自哪个配置对象)、`enabled`;stdio 类 MCP 服务器标为「本地进程,其外连不在清单内」。「与实际外连一致」的保证办法:一个测试在假端点下把各类外连各走一遍并记录目的地,断言都在清单里;再加一个 `scripts/check-egress.mjs`,在 CI 里检查生产代码使用网络 API(`fetch`、`node:net`、`node:tls`、`node:http(s)`、`WebSocket` 客户端)的文件都在登记表里,新增网络调用点必须登记并说明对应的清单来源。更新检查目前不存在,清单里不出现这一类;将来加更新检查时必须同时登记。
  - **ADR 0029 · 知识地图浏览器、人物与 `/map`**:
    - `GET /items/{id}/related`(非 primary 边关联的条目,「也出现在…」与提及的人物);`POST /items/{id}/ask`(`scope: 'item' | 'subtree'`,返回 `sessionId`);ETag / `If-None-Match`(读接口,弱 ETag,304);都是新增,不改已有响应。
    - `characters` 提供者:人物条目的 `type` 为 `character`,`source = 'characters'`;「人物」根节点;邮件联系人的识别与去重规则(问题 7);边的解读(问题 6)。
    - **不可信内容**:`ask` 创建的会话带条目标题、摘要或子树摘要,邮件相关的条目一律置会话 `untrustedContentSeen`(与现有「问 AI」邮件入口一致);联系人显示名来自邮件头,按不可信文本显示、不渲染 HTML。
    - `/map` 的交互(问题 8):状态存在渠道运行器的内存里,有效期 5 分钟;列表只含标题与计数;叶子只给标题、类型与截断的摘要,不发正文;`/map` 的回复不写入会话。
- 验收:四份 ADR 定稿;shared 中的新 schema 只新增,不改已有 schema;OpenAPI 检查(`openapi-compat`)通过;每份 ADR 末尾列出实现 PR 的测试清单。

### PR 4 · `feat/secrets-encryption`

- 目标文件:`packages/providers/src/secrets.ts`(`SecretStore` 读写加密文件)及其测试;新增 `packages/providers/src/secrets-crypto.ts`(信封、主密钥来源)及测试;`apps/server/src/data-dir.ts`(主密钥文件的创建与权限检查)、`apps/server/src/channels/wechat.ts`(令牌写入走 `SecretStore`,已是这样则保持并补测试);`apps/server/src/routes/settings.ts`(密钥状态、触发迁移的接口,具体路径由 ADR 0026 定);`apps/web/src/SettingsPage.tsx` 附近新增「密钥」一节(状态、指纹、迁移按钮);`scripts/check-secrets.mjs`(CI 里已有 `check:secrets`,扩展到加密文件与 `master.key` 不进仓库)。
- ADR:是(ADR 0026,PR 3 已写)。迁移:**不需要数据库迁移**(0015 留给 TOTP),但**有数据目录文件迁移**(明文 `secrets.yaml` → 加密文件),属于方案里的「迁移」类风险。
- 风险:**高(数据目录、`secrets.yaml`、密钥)。必须等业主明确同意才合并。**
- 手工验证与 Windows:
  - 步骤:用一份含模型 key 与 iLink 令牌的测试数据目录(复制,不用真实数据)跑迁移;重启后模型调用与微信连接照常;删掉 `master.key` 后服务器仍能启动并报「密钥不可用」;`FATCAT_MASTER_KEY` 覆盖生效;迁移到一半失败(写入失败、回读不一致)时明文原样保留。
  - 需要 Windows 真机:`master.key` 与加密文件的 ACL;备份目录的写入;路径含中文或空格的数据目录。真实微信令牌的迁移后重连(业主侧)。
- 测试(只写核心纯逻辑):信封加解密往返与篡改检测;主密钥来源的优先级;迁移的「回读比对失败不动明文」;写入只改目标键并先备份(保留 `secrets-write.test.ts` 已有用例);**扫库测试**:建好模型配置档、邮件账户、渠道、MCP 服务器后,遍历数据库全部文本列,断言找不到测试用的明文 key 与令牌(验收项 3 的依据)。
- 验收:数据库与 `secrets` 文件里找不到明文密钥(扫库测试 + 加密文件不含明文子串);迁移可重复执行、失败不丢数据;`pnpm check:secrets`、`pnpm check:licenses` 通过;不新增依赖。

### PR 5 · `feat/totp`

- 目标文件:`packages/storage/src/migrations/0015_totp.ts`(新增,编号以合并时为准)与 `packages/storage/src/auth.ts`(或新建 `totp.ts`)仓储;`apps/server/src/routes/auth.ts`(登录两步、启用、关闭、恢复码);`apps/server/src/auth/totp.ts`(RFC 6238 与限流,新增);`packages/shared/src/auth.ts`(PR 3 的 schema);`apps/web/src/AuthForm.tsx`(验证码输入)、`apps/web/src/SettingsPage.tsx`(安全一节:启用 / 关闭、恢复码、二维码);`packages/client` 与 `apps/cli`(登录流程带验证码,只在命令行登录时涉及)。
- ADR:是(ADR 0027)。迁移:**是**,0015 建 TOTP 凭据与恢复码表(密文存共享密钥、哈希存恢复码、最后使用的时间步长)。
- 风险:**高(登录、迁移)。必须等业主明确同意才合并**(新迁移需要业主同意,与 0011、0014 的做法相同)。
- 手工验证与 Windows:用真实手机上的验证器 App 扫码、登录、输错、用恢复码登录、关闭;时钟偏差 ±30 秒的行为;重启后仍然有效。**真实验证器 App 与 Windows 浏览器列入清单,由业主侧测**。
- 测试(核心纯逻辑):RFC 6238 官方测试向量;窗口与重放(同一步长第二次失败);恢复码一次性;限流锁定;临时凭证不能当会话用(越权用例);关闭 TOTP 需要第二因素(越权用例);未启用 TOTP 的账户登录流程不变(回归)。
- 验收:开启 TOTP 后无第二因素无法登录(开发计划验收项 2);已有会话与个人访问令牌的行为符合 ADR 0027;OpenAPI 只增不改。

### PR 6 · `feat/egress-targets`

- 目标文件:`apps/server/src/routes/settings.ts`(或新建 `apps/server/src/routes/egress.ts`)与 `apps/server/src/egress.ts`(新增,汇总模型配置档、嵌入、语音、邮件账户、渠道、MCP 的目的地);`apps/server/src/egress.test.ts`(一致性测试);`scripts/check-egress.mjs`(新增)与 `package.json` 的脚本、CI 步骤;`apps/web/src/SettingsPage.tsx`(清单一节,只读);`apps/server/src/openapi.ts`。
- ADR:是(ADR 0028)。迁移:无(清单现算)。风险:中(只读接口,但清单不全会让「零遥测」的说法失真,所以一致性检查是重点)。
- 测试:一致性测试(假端点下各类外连走一遍,目的地都在清单里);`check-egress` 对未登记的网络调用点失败;清单不含路径、查询与凭据(脱敏用例);未登录 401。
- 验收:设置页的外连目标清单与实际外连一致(开发计划验收项 4);界面截图。
- 同时在 README 与文档站首页的零遥测承诺里指向这份清单(第 10 节要求,随 PR 9 的文档一并核对)。

### PR 7 · `feat/people-provider`

- 目标文件:`packages/items/src/characters.ts`(新增提供者)与测试;`packages/items/src/index.ts`(注册);`packages/storage/src/items.ts` 与 `apps/server/src/routes/items.ts`(`/items/{id}/related`);`apps/server/src/mail-items.test.ts` 同类的联系人测试;`packages/shared/src/items.ts`(PR 3 的 schema)。
- ADR:是(ADR 0029 的人物部分,PR 3 已写)。迁移:**预计不需要**(`items`、`item_edges` 已有 `rel`、`primary_edge`;联系人的规范化地址放 `source_ref` 与 `meta`)。如果实现中发现必须加索引或表,停下来在 PR 里提出,不自行加迁移。
- 风险:中。涉及邮件内容的使用(只取 From / To / Cc 的显示名与地址,不读正文)和性能(1 万封邮件同步后人物边的数量);按 ADR 0018 用合成的 1 万封邮件测一次空闲 RSS 与同步耗时,数字写进 PR。
- 内容:
  - 「人物」根节点与人物条目(`type = 'character'`),每个人物恰有一条 primary `contains` 边挂在「人物」下;识别与去重规则按问题 7。
  - 联系人与邮件的关系用非 primary 边(`mentions`),每个人最多链接最近的一批邮件(问题 6 的推荐值),重新同步时重算;`/related` 返回「也出现在…」。
  - 联系人条目只含显示名、地址与计数;显示名当不可信文本。
  - 敏感度:不把记忆(`sensitivity` > 1)混进人物条目;这一版人物只来自邮件(记忆里的人物抽取不在 M5b,第 6 节)。
- 测试:地址规范化与去重;非 primary 边不改变 `descendant_count`(与 ADR 0012 第 1 节的计数规则一致);超过上限只链接最近的;软删邮件后边与计数一致(属性测试沿用 `items-counts.test.ts` 的对照);越权(别人的条目 404)。
- 验收:联系人出现在「人物」下;从邮件条目能看到「也出现在…」;`recount` 对照通过。

### PR 8 · `feat/category-browser`

- 目标文件:新增 `packages/ui/src/category-browser/`(组件与纯逻辑:树状态、游标分页合并、面包屑、虚拟窗口);`apps/web/src/ItemsPage.tsx`(改为使用新组件);`apps/server/src/routes/items.ts`(`POST /items/{id}/ask`、ETag);`packages/items/src/service.ts`(ask 的上下文组装);`apps/web/e2e/`(新增分类浏览器的冒烟用例,含手机宽度);`apps/web/src/i18n.ts`(中英文案);`packages/client`(新增 `ask`、`related` 方法)。
- ADR:是(ADR 0029)。迁移:无。API:只增(`ask`、ETag);`related` 在 PR 7。
- 风险:中。界面改动必须在浏览器里实际点过并附截图(桌面与手机宽度各一张以上);`ask` 把条目内容带进会话,属于不可信内容路径,要有注入类用例。
- 内容(对应开发计划 4.1.1 的 v1.0 版,纯 REST):
  - 懒加载树(展开才请求 `children`);右侧列表虚拟滚动 + 游标分页 + 按类型 / 时间排序;面包屑来自 `ancestors`;计数徽标用 `contentCount`(ADR 0025)。
  - 条目详情:「打开」按类型渲染(邮件正文纯文本、章节文本、文件预览),「问 AI」用 `POST /items/{id}/ask`(条目或子树)。
  - 子树内搜索:`/items/search?under=`。
  - 手机响应式:树收进抽屉,列表整宽,触摸目标不小于常规尺寸。
  - 虚拟滚动:问题 10 的推荐是 `@tanstack/react-virtual`(MIT,只进 Web 包,不影响服务器内存);加依赖前过 `pnpm check:licenses`。
  - 粒子球不做;但树状态、选中状态保持与视图无关,M10 可以复用(开发计划 4.1.1 要求「同一 API、同一选中状态」)。
- 测试(核心纯逻辑):分页合并不重复不丢;虚拟窗口的范围计算;面包屑切换;`ask` 的上下文组装与 `untrustedContentSeen`;ETag 304;Playwright 冒烟:从「邮件」「小说」「人物」三个顶层类别各下钻到最深条目并打开。
- 验收:开发计划验收项 1——Web UI 知识地图可从任一顶层类别(邮件 / 小说 / 人物)下钻到最深条目并打开或「问 AI」,全程只用 REST。

### PR 9 · `feat/channel-map`

- 目标文件:`packages/channels/src/commands.ts`(解析 `/map`、数字、`0` / 「返回」)与 `packages/channels/src/format.ts`(列表的纯文本排版与切段,复用现有降级与切段);`apps/server/src/channels/hub.ts`(地图状态、调用 items 服务,只用主人的 `ownerId`);`apps/server/src/channel-injection.eval.test.ts`(新增 `/map` 用例);文档:README、CHANGELOG(中英)、渠道说明里的 `/map` 与 `/help` 文案;`docs/milestones/M5b-self-check.md`(新增)。
- ADR:是(ADR 0029 的 `/map` 部分,PR 3 已写)。迁移:无。API:无新增(用 items 服务,不经 HTTP)。
- 风险:中。IM 输出的是主人自己的数据,不涉及对外发送,但条目标题(邮件主题)是不可信文本,数字应答存在劫持普通聊天的风险;按问题 8 的推荐收紧。真实微信的复测项列清单,不自己做。
- 内容:`/map` 列出顶层类别与编号;回复编号下钻,`0` 或「返回」上一层,再发 `/map` 回到顶层;每页最多 9 项,更多时「回复 9 之后发『下一页』」之类的提示由 ADR 定;叶子给标题、类型和截断的摘要并提示「在 Web 打开」。
- 测试(越权与注入):非主人、群聊的 `/map` 被忽略(沿用忽略类);带引用的数字不当应答;窗口过期后的数字当普通聊天;标题里写着「确认 K7」之类的文字不产生审批(出站文本不被当指令);`/map` 与 `/new`、`/help` 同样计入主人限流;别的 `ownerId` 的条目不出现。
- M5b 自检报告:按本文件第 4 节逐条对照,写测试名与 CI 运行号,没有证据的写「未验证」;真机项(第 3 节)单列;M5a 自检报告第五节的遗留项逐条给出去向。

## 3. 安全检查清单(每个 PR 都要过)

- 审批只认主人私聊里的短码;带引用、转发、链接卡片的消息按不可信内容处理,不能构成审批(PR 2 补上引用这一条);审批提醒带上警告;对外发送一律需审批。
- 新接口都需要登录,按 `ownerId` 取数据;越权用例必须有;`/map` 与 `ask` 只能读主人的条目。
- 密钥只放 `secrets` 文件(加密后为密文)或环境变量,数据库只存引用或密文;`master.key`、`secrets` 文件、`backups/` 不进仓库、不进日志;写密钥文件先备份、只改目标键、解析失败不写、迁移回读比对失败不动明文。
- TOTP 共享密钥与恢复码不入日志、不回显(二维码内容只在启用时显示一次);验证码比较用常数时间;限流与重放保护有用例。
- 外连清单只含协议、主机、端口;不含路径、查询与凭据;不引入遥测、不引入 copyleft 依赖;新增依赖先测内存(ADR 0018)并过 `pnpm check:licenses`。
- 条目标题、联系人显示名、邮件摘要都按不可信文本显示与转发,不渲染 HTML;`ask` 创建的会话对邮件相关条目置 `untrustedContentSeen`。
- 日志只记渠道 id、条目 id、长度与状态码,不记正文、标题、地址和令牌。
- 涉及数据目录、`secrets` 文件、迁移的 PR(4、5)和涉及审批的 PR(2)在描述里写明手工验证步骤与哪些需要 Windows 实测;4、5 等业主明确同意才合并。
- 净室:联系人识别与 TOTP 只依据 RFC 6238 与本方案;不参考第三方项目的源代码(沿用 AGENTS.md「净室实现」)。

## 4. 验收对照(开发计划 M5b)

| 开发计划验收项                                                                                      | 对应 PR                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. Web UI 知识地图可从任一顶层类别(邮件 / 小说 / 人物)下钻到最深条目并打开或「问 AI」,全程只用 REST | PR 7(人物与 `related`)、PR 8(浏览器、`ask`、ETag);契约在 PR 3 |
| 2. 开启 TOTP 后无第二因素无法登录                                                                   | PR 5(契约 PR 3、密钥加密 PR 4)                                |
| 3. 数据库中找不到明文密钥                                                                           | PR 4(扫库测试;TOTP 的共享密钥在 PR 5 也过同一个扫库测试)      |
| 4. 设置页的外连目标清单与实际外连一致                                                               | PR 6(一致性测试与 `check-egress`;契约 PR 3)                   |

开发计划 M5b 正文里的其余条目:

| 条目                                                      | 对应 PR                |
| --------------------------------------------------------- | ---------------------- |
| `CategoryBrowser` 完整版(各项子功能)                      | PR 8                   |
| `characters` 提供者、邮件联系人的非 primary 边            | PR 7                   |
| IM `/map` 指令                                            | PR 9                   |
| 零遥测落地:设置页列出全部外连目标                         | PR 6                   |
| M5a 自检遗留:审批警告、已处理回复、引用审批、陌生人绑定码 | PR 2                   |
| M5a 自检遗留:`SecretStore` 统一写入、备份策略复核         | PR 3(决定)、PR 4(实现) |
| M5a 自检遗留:渠道内存增量                                 | 已由 #27 完成          |
| M5b 自检报告                                              | PR 9                   |

粒子球导航不在 1.0 范围(第 16 节),不对应任何 M5b 的 PR。

真机与人工项(只列清单,由业主侧测):

| 项                                                                      | 环境                     | 涉及 PR |
| ----------------------------------------------------------------------- | ------------------------ | ------- |
| 真实微信:带警告的审批提醒、Web 先批后 IM 再回、引用消息、陌生人发绑定码 | 真实微信 + iLink         | 2       |
| 真实微信:`/map` 下钻、数字应答、窗口过期                                | 真实微信                 | 9       |
| Windows:`master.key` 与加密文件的权限、备份写入、迁移、含中文或空格路径 | Windows                  | 4       |
| 真实微信令牌在迁移到加密文件后能否重连                                  | 真实微信                 | 4       |
| 真实手机上的验证器 App 扫码、登录、恢复码、关闭;Windows 浏览器登录      | 手机 + Windows           | 5       |
| 手机浏览器与触摸:分类浏览器的抽屉、滚动、「问 AI」                      | 真实手机                 | 8       |
| 真实邮箱(1 万封量级)同步后的人物数量、内存与耗时                        | 真实邮箱                 | 7       |
| 反向代理 / 公网暴露下 TOTP 登录与设置页清单                             | 反向代理 + HTTPS(M5c 前) | 5、6    |

## 5. 待业主决定

每条先给推荐;不回复就按推荐做。**例外**:合并、发信、改动数据目录或真实数据,必须等业主明确同意(问题 3、4 的落实,以及 PR 4、PR 5 的合并)。

1. **未绑定时陌生人发「绑定 ######」,码错误要不要回复?要不要计入每分钟 120 条上限?** 现状是回「绑定码不对」,而且不计入上限。**推荐:码错误(含没有配对码、已过期、已锁定)不回复,并计入忽略类的每分钟 120 条上限;码正确才回「已绑定。」**。理由:与 M5a 问题 6「非主人不回复」一致,回复会暴露这是机器人、也能被用来探测是否有待用的配对码;代价是主人手误输错码时微信里没有任何反馈,只能在 Web「渠道」页重新生成配对码再试(现在的渠道状态里没有失败次数字段,要显示它得改 shared,所以 PR 2 不做)。
2. **主密钥放哪里?** 选项:(a)数据目录里自动生成的 `master.key`,环境变量可覆盖;(b)必须由用户通过环境变量或文件提供,没有就不加密。**推荐 (a)**,公网部署的文档建议改用环境变量或容器 secret。理由:(b)让默认安装得不到任何保护或需要额外步骤;(a)的局限(拿到整个数据目录就能解密)在 ADR 0026 与文档里写明。
3. **明文 `secrets.yaml` 怎么迁移?** 选项:(a)启动时自动迁移;(b)用户在设置页点一下(或运行一条命令)才迁移,失败不动明文。**推荐 (b)**,并且迁移成功后才处理明文;已有的明文备份是否一并加密或删除,在迁移界面上写明并让用户确认。理由:这是数据目录里真实密钥的改动,业主规则要求明确同意;自动迁移一旦出问题没有后悔药。
4. **`secrets` 备份策略再确认**(M5a 自检第五节第 7 项:#19 的待决问题,本方案没有找到业主的明确确认记录)。**推荐:沿用 `backups/` 目录、保留 5 份,备份内容为密文;主密钥不进自动备份**,设置页显示主密钥指纹方便核对。
5. **TOTP 的范围与恢复**:(i)个人访问令牌不受 TOTP 约束,但创建令牌必须在通过第二因素的会话里;(ii)10 个一次性恢复码,启用时显示一次;(iii)验证码和恢复码都丢了,可以在服务器本机用命令重置(需要访问数据目录)。**推荐 (i)(ii)(iii) 全部这样做**。理由:命令行与 API 客户端用令牌,不改它们的流程;重置只对能碰数据目录的人开放,不产生新的远程入口。
6. **「联系人挂到人物下(非 primary 边)」怎么读?** 开发计划 6.2 要求每个条目恰有一条 primary 边。**推荐的读法:每个人物的 primary 边挂在「人物」根下(树里能下钻到人物),人物到相关邮件的关系用非 primary 的 `mentions` 边(「也出现在…」与 `/related`);每个人最多链接最近的 200 封邮件**,重新同步时重算。理由:不破坏严格树与计数规则(ADR 0012 第 1 节:计数只沿 primary 边),也不让 1 万封邮件产生几万条边;200 这个数以 1 万封合成邮件下的内存与耗时实测后微调,写进 PR 7。
7. **哪些邮件地址算「联系人」?** **推荐:主人发出过邮件的收件人,加上来信不少于 2 封的发件人;排除明显的系统发件地址(`noreply`、`no-reply`、`donotreply` 等)和带 `List-Id` 的群发邮件;按小写地址去重,显示名取最近一次的**。不做人物合并与手动编辑(推迟,第 6 节)。理由:避免把一次性营销邮件全变成「人物」;阈值是启发式,发现不合适再调,不涉及数据迁移。
8. **`/map` 的数字应答怎么防止劫持普通聊天?叶子给不给正文?** **推荐:最近一次 `/map` 回复后的 5 分钟内、整条消息只有数字或 `0` / 「返回」时才当应答,其余按普通聊天;带引用的消息不当应答;叶子只给标题、类型和截断的摘要,不发邮件或章节正文,提示「在 Web 打开」;`/map` 的回复不写入会话。** 理由:主人在 5 分钟内单独发「2」当聊天的概率低,窗口外不受影响;正文留在 Web 里避免在 IM 里转出邮件原文,也避免把不可信文本放进会话。
9. **审计的 `channelId` / `via` 字段**(M5a 自检第五节第 4 项)要不要在 M5b 加?需要新字段与迁移。**推荐:不加,继续用摘要后缀**,出现按渠道筛选审计的需求时再做。理由:M5b 已有两个带迁移或数据目录改动的高风险 PR,不再增加。
10. **虚拟滚动用库还是自己写?** **推荐 `@tanstack/react-virtual`(MIT),只进 Web 包**;先过 `pnpm check:licenses`,服务器内存不受影响。自己写的话变高行与动态高度会让这个 PR 变大。
11. **M5b 自检报告放哪个 PR?** 方案共 10 个 PR(含 2b)。**推荐并入最后一个功能 PR(PR 9)**,与 CLAUDE.md「小改动并入相关 PR」一致;代价是 PR 9 比其他 PR 多一份文档。

## 6. 推迟项

- 企业微信(M5a 推迟,排期另定;重新开始前先写 ADR 修订 ADR 0022 第 11 节)。
- 粒子球导航 `KnowledgeSphere` → M10(第 16 节已定)。
- 人物的合并、去重后的手动编辑,以及从记忆 / 知识库抽取人物 → 1.0 之后(M5b 的人物只来自邮件联系人)。
- 审计的渠道字段(问题 9)→ 有需求时再做。
- `/map` 里打开条目正文、从 IM 发起「问 AI」 → 1.0 之后。
- 群聊中的完整对话、IM 回复语音与 AMR / SILK 解码 → 1.0 之后(M5a 问题 4)。
- 定时推送到渠道 → M6。
- CodeQL / Semgrep、部署文档、Docker 一键部署、Release、内存基线更新为 v1.0 的实测值 → M5c。
- 多用户的渠道绑定、TOTP 的多账户管理 → 2.0。
- 更新检查:当前代码中不存在;将来加入时必须登记进外连清单(ADR 0028)。

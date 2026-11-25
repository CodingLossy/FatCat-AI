# ADR 0051 · ownerId 覆盖审计(M13 后段 2)

- 状态:提议(按 `docs/milestones/M13-plan.md`「后段顺序」第 2 项)
- 日期:2026-11-25
- 相关:ADR 0003(条目索引与 `ownerId`)、ADR 0005(存储)、开发计划第 16 节「1.0 仅单用户,表结构预留 `ownerId`」
- 范围:审计现状、定规则、加两道自动检查。不改接口、不改表结构、不写迁移;多用户本身是后段第 4 项(多用户 ADR)。
- 语言:中文;代码标识符、表名和文件名保留英文。

## 0. 背景

1.0 只允许一个主人账户(`owners` 表上有触发器),但从 M1 起每张「属于某个人」的表都带 `owner_id`,仓储方法按 `ownerId` 过滤,为以后的多用户做准备。这个约定一直靠写代码的人自觉:没有检查能发现某个新方法忘了按 `ownerId` 过滤,也没有测试系统地验证「别人的 id 拿不到」。只有渠道、条目问答、附件等少数几处有手写的越权用例。

多用户之前要先确认两件事:现有代码确实处处按主人隔离;以后加的代码不会悄悄破坏它。

## 1. 现状(2026-11-25 盘点)

**表**:55 张表里 38 张带 `owner_id`。另外 17 张不带,分三类:

- 挂在父表下的子表,归属跟着父表走:`channel_bindings`、`channel_pairings`、`channel_inbox`、`mail_folders`、`mail_messages`、`mail_message_folders`、`mail_attachments`、`mail_drafts`(经 `mail_accounts`)、`task_runs`、`task_webhook_tokens`(经 `tasks`)、`memory_sources`、`memory_feedback`(经 `memory_facts`)、`session_summaries`(经 `sessions`)、`item_edges`(经 `items`)、`device_tokens`(经 `devices`)。
- 全局状态:`embed_state`(嵌入模型状态,整个安装共用)。
- `owners` 本身。

**仓储方法**:`packages/storage` 里 271 个方法,183 个参数里有 `ownerId`。其余 88 个逐个看过调用处,都属于下面四类之一,没有发现越权:

| 类别         | 数量 | 含义                                                                              | 例子                                                                                                   |
| ------------ | ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `system`     | 26   | 后台任务或启动时对所有主人做的事,每行自带 `ownerId`                               | `tasks.listActive`、`channels.allEnabled`、`audit.purgeBefore`                                         |
| `child`      | 46   | 按子资源 id 操作,调用方已经用 `ownerId` 查到了父资源,或者是运行时自己创建的资源   | `tasks.listRuns`(路由先 `taskOr404(ownerId, id)`)、`mailCache.deleteDraft`(先 `getDraft(ownerId, id)`) |
| `credential` | 14   | 按秘密的哈希查找(登录会话、令牌、设备刷新令牌、webhook 令牌),查到的行带 `ownerId` | `authSessions.getValid`、`devices.rotate`                                                              |
| `internal`   | 5    | 不碰主人数据                                                                      | `transaction`、`embeddings.state`                                                                      |

每个方法的类别和理由登记在 `scripts/owner-scope.json`(第 3 节)。`memories.purgeQuarantine` 目前没有生产代码调用,照实写在理由里。

**路由**:OpenAPI 里 61 个带路径参数的「方法 + 路径」。第 4 节的扫描测试逐条用别人的 id 调过:没有一条返回 2xx,也没有一条和「不存在的 id」回答不同;别人的数据一行没变。

## 2. 规则

1. 带 `owner_id` 的表,读写它的仓储方法参数里要有 `ownerId`,SQL 里按它过滤。
2. 不带 `ownerId` 的仓储方法只能是第 1 节的四类之一,并且登记理由。`child` 类的调用方必须先用 `ownerId` 查到父资源(路由里就是 `xxxOr404(ownerId, id)`)。
3. 别人的资源和不存在的资源对外**一模一样**:同样的状态码、同样的错误码,不多透露「它存在」。多数路由是 404;少数本来对「不存在」就回别的码的也一样(例如 `POST /approvals/{callId}` 对没有待审批项回 409 `approval_not_pending`)。
4. 1.0 只有一个主人。多用户 ADR 之前,这些规则只是防线,不改变任何行为。

## 3. 静态检查:`pnpm check:owner-scope`

`scripts/check-owner-scope.mjs` 扫 `packages/storage/src` 的仓储文件(按 Prettier 排版,方法是缩进 8 格的定义),每个方法要么参数里有 `ownerId`,要么在 `scripts/owner-scope.json` 里登记 `key`(`文件:对象.方法`)、`category`(上面四类)和 `reason`。

- 新加的方法没有 `ownerId` 又没登记 → 失败,提示加 `ownerId` 或登记。
- 登记了但代码里已经没有、已经带 `ownerId`、重复登记、类别不对、理由太短 → 失败。
- 自测 `scripts/check-owner-scope.test.mjs`;CI 的 checks 任务里和 `check:egress` 放在一起跑。

这是文本扫描:它保证「每个例外都有人想过并写下理由」,不证明 SQL 真的按 `ownerId` 过滤。后者由第 4 节的测试从外面验证。

## 4. 越权扫描测试:`apps/server/src/owner-scope.test.ts`

- 关掉外键,在一个不存在的主人(`someone-else`)名下直接写进一整套资源:会话、消息、运行、代理、任务和运行、渠道(已绑定)、模型配置档、邮箱账户和草稿、记忆、MCP 服务器、授权目录、条目、附件、令牌、设备、预授权、插件、审批请求。和 `channels.test.ts` 的做法一样(1.0 不允许建第二个主人)。
- 读 `openapi/v1.json`,对每一条带路径参数的路由,用主人的身份分别拿「别人的 id」和「不存在的 id」各请求一次。请求体按 OpenAPI 的 schema 自动拼一个最小合法值,拼不出的几条手写。要求:两次回答相同,不是 2xx,而且对照请求不是 400(否则说明请求体没过校验、没走到归属检查)。
- 扫完以后,这些表里的内容和扫之前逐行相同。
- 每条带参数的路由都必须在测试的 `ROUTE_IDS` 里登记资源类型;新加路由忘了登记,测试失败。
- 两处只核对「不存在」的回答,并写明由哪个已有测试覆盖别人的情况:`/tool-calls/{callId}/result`(调用只在内存里,`client-calls.test.ts`)。邮件正文、附件、记忆冲突和隔离区的 id 在扫描里是不存在的 id,因为造出它们要走完整的同步或抽取流程;它们的路由都先用 `ownerId` 查行,404 与不存在一致。

验证过测试会抓到问题:把夹具里的代理改到主人名下再跑,`DELETE /agents/{id}` 立刻报「theirs 204, nonexistent 404」。

## 5. 不做

- 不改任何仓储方法的签名(审计没发现需要改的)。
- 不做行级安全或数据库层面的隔离;SQLite 没有,多用户 ADR 再议。
- 不扫 SQL 文本:规则 1 的「SQL 里按它过滤」靠第 4 节从外面验证。

## 6. 待业主决定

- 别人的资源对外和不存在一模一样(规则 3),包括少数回 409 的路由。推荐:保持;不透露别人的 id 是否存在比统一成 404 更重要,而这些路由对不存在本来就这样回答。

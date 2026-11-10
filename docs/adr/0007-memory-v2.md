# ADR 0007 · 记忆 v2:有类型、可更替、带出处的记忆(含净室声明)

- 状态:已采纳(业主 2026-11-03 正式采纳《记忆模块补充设计》)
- 日期:2026-11-03
- 来源:`docs/plan/FatCat-AI-记忆模块补充设计.md`(下称「补充设计」);开发计划 6.2、第 7、12、13、15、16 节
- 编号说明:补充设计原拟 `0004-memory-v2.md`;0004–0006 已用于 M1 契约,本 ADR 顺延为 0007。

## 0. 净室声明(必须遵守)

补充设计参考了以下项目的**思想**:Danialsamadi/synapse(GPL-3.0)、UnKnownFish125/dsh-deepmemory(AGPL-3.0)、adoresever/graph-memory(许可证未核实)、liangmianya/dsh-synapse(许可证未核实)。为保证双许可成立(开发计划 13.4、15.2):

1. 只借鉴思想与架构,**不复制任何代码、SQL、提示词、测试数据、文案或配置**。即使许可证与本项目相同(AGPL),版权属于他人,同样不可复制。
2. 实现者只依据补充设计与本 ADR(用我们自己的话写的规格)编码;实现期间不打开、不搜索上述仓库的源码。PR 模板中勾选「未参考第三方源码,仅依据 docs/plan 规格」。
3. 不把上述项目加为依赖,不做 submodule 或 vendoring;许可证白名单 CI 照常生效。
4. 「未核实」的两个项目同样按「仅思想」处理;如需复用具体内容,先核实许可证并另写 ADR。
5. 可以在 NOTICE 或文档致谢中按名称致谢这些项目的思路;这不是许可要求,也不带来许可义务。

本条同时写入 AGENTS.md。

## 1. 决定

采纳补充设计第 1–8 节的目标、数据模型、写入 / 检索路径、生命周期任务、反馈闭环、知识地图与会话地图接入、REST 与工具接口,并按下面的复审意见调整。分阶段落地:

| 阶段             | 内容                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1(最小子集)** | 建 `items`、`item_edges`、`items_fts`(只建表与同步触发器,不做知识地图 API);建 `memory_facts` 子集与 `memory_sources`;会话 / 消息表一开始就带分叉列;工具 `memory.save` / `memory.search`(以后作为 `memory.write` / `memory.retrieve` 的别名保留),`memory.save` 默认需要审批;检索只用 FTS5(含 1–2 字查询的 LIKE 回退);最小凭据拒存规则 |
| **M2(记忆核心)** | 补齐 `memory_facts` 其余列、冲突 / 反馈 / 隔离区 / digest 表、向量表;完整写入路径(抽取、去重、更替、冲突)、三路召回 + RRF + 可信度说明 + 预算、digest、维护任务、反馈、REST 全集、`memory` ItemProvider、fork API、Web 记忆页                                                                                                        |
| **M10(可视化)**  | 粒子球中的记忆簇编码、会话地图 2D 画布                                                                                                                                                                                                                                                                                               |

### M1 的 `memory_facts` 子集

```sql
CREATE TABLE memory_facts (
  item_id     TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  mem_type    TEXT NOT NULL CHECK (mem_type IN ('episodic','semantic','procedural')),
  subtype     TEXT,
  entity_key  TEXT,
  cardinality TEXT NOT NULL DEFAULT 'multi' CHECK (cardinality IN ('single','multi')),
  value_json  TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','superseded','conflicted','retracted','expired')),
  domain      TEXT NOT NULL DEFAULT 'general' CHECK (domain IN ('work','life','general')),
  sensitivity INTEGER NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 2),
  confidence  REAL NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  origin      TEXT NOT NULL CHECK (origin IN ('user_explicit','extracted','consolidated','manual','imported')),
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_mem_single_active ON memory_facts(owner_id, entity_key)
  WHERE entity_key IS NOT NULL AND cardinality = 'single' AND status = 'active';
CREATE INDEX idx_mem_lookup ON memory_facts(owner_id, status, mem_type);
```

`memory_sources` 按补充设计 2.2 原样建立(它引用 `sessions`、`messages`、`items`,M1 都已存在)。M2 再用 `ALTER TABLE ADD COLUMN` 补齐 `supersedes_id`、`decision_state`、`tier`、`importance`、`decay_score`、`pinned`、`valid_from/to`、`last_*`、各计数、`vec_rowid`、`embed_model`;这些列要么没有外键,要么默认值为 NULL,符合 SQLite 对 `ADD COLUMN` 的限制,不需要重建表。

## 2. 复审意见(对补充设计的调整)

1. **向量表维度不能写死**:补充设计 2.2 中 `vec0(embedding float[1024])` 改为:不放进静态迁移,在用户配置 embed 档后由代码按该档维度创建;换维度时后台重建(ADR 0005 第 3 节)。
2. **级联删除与触发器**:`items` 硬删除 → 外键级联删除 `memory_facts` → `trg_memvec_cleanup` 清理向量。SQLite 中外键动作引发的删除会触发 DELETE 触发器,但必须有测试覆盖(补充设计 9 节属性测试 (d))。
3. **更替事务的顺序**:由于部分唯一索引 `ux_mem_single_active`,事务内必须**先**把旧记录改为 `superseded`,**再**插入新的 active 记录,否则会违反唯一约束。
4. **会话 / 消息的分叉列**:补充设计用 `ALTER TABLE` 给 `sessions`、`messages` 加外键列;改为 M1 建表时直接包含,M2 不再修改这两张表。
5. **FTS5 trigram 的限制**:少于 3 个字符的查询在 trigram 下无结果,按补充设计 4.1 用 `LIKE` 回退(只扫 active,最多 30 条);`items_fts` 使用外部内容表 + 触发器同步,M1 建立。
6. **zod 4 写法**:草图中的 `z.record(z.unknown())` 应为 `z.record(z.string(), z.unknown())`;`z.string().datetime()` 应为 `z.iso.datetime()`。M2 写 `packages/shared/src/memory.ts` 全量时按 zod 4 写法。
7. **工具命名与审批**:M1 的 `memory.save` / `memory.search` 保留为 `memory.write` / `memory.retrieve` 的别名。补充设计中 `memory.write` 默认预授权,与业主对 M1 的决定(`memory.save` 默认需要审批)不同;M1 按业主决定执行,M2 再定。
8. **契约变更**:`item_edges.rel` 增加 `supersedes`、`forked_from`,以及新的 AgentEvent `memory-used`,都属于 `packages/shared` 的契约变更,在 M2 对应 PR 中与本 ADR 一并实现;M1 的表中 `rel` 是普通 TEXT,不受影响。
9. **2GB 预算**:`memory.sleep`(整理)每次最多 10 次 LLM 调用、额外内存 < 60MB 的目标合理;是否放在 M2 还是推迟到 M6 由业主在 M2 方案中决定。

## 3. 后果

- M2 只需增量迁移,不需要重建 M1 的表。
- 记忆与知识地图共用 `items` / `item_edges` / `items_fts`,M1 就要承担这几张表的触发器与计数维护的最小实现。
- 净室要求成为长期约束,PR 模板与 AGENTS.md 中都有体现。

## 4. M1 落地情况(PR feat/context-memory)

- `packages/storage` 的 `memories` 仓储:同类型同文本合并(置信度 +0.05)、单值 `entity_key` 先标旧值 `superseded` 再插入新值、trigram FTS 检索(1–2 字查询回退 `LIKE`)、编辑、撤回、硬删除(级联删除出处)。
- `packages/memory`:凭据拒存的最小规则(API key、访问令牌、JWT、私钥、「密码是 …」类赋值、高熵串);`user.*` 与 `pref.*` 默认单值;初始置信度按来源。
- 工具:`memory.save`(每次都需要用户审批,来源固定为当前会话)与 `memory.search`(只读)。审批端点 `POST /api/v1/approvals/{callId}`;等待审批时运行状态为 `waiting_approval`,取消运行即视为拒绝。
- REST:`GET/POST /api/v1/memory`、`POST /api/v1/memory/search`、`GET/PATCH/DELETE /api/v1/memory/{id}`;用户经 REST 写入的记忆 `origin = user_explicit`,无需审批。
- 上下文压缩:最近原文不超过上下文窗口的 40%(至少 2 条),更早的消息用 cheap 配置档(没有则用 chat)压缩成摘要段存入 `session_summaries`;压缩失败时丢弃最旧的消息,运行照常进行。

## 5. M2 落地细节(M2 PR 10 起)

本节写入 M2 方案第 6 节的业主决定(2026-11-04 全部按建议),以及 M2 实现时对补充设计的进一步调整。实现仍然只依据补充设计与本 ADR(第 0 节)。

### 5.1 业主决定

| 问题                  | 决定                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sleep 整理            | 推迟到 M6,与通用定时任务一起做。M2 只做不调 LLM 的 decay / tier / expire;hygiene / optimize 推迟(M2 方案第 7 节)                                                                              |
| 自动抽取              | 默认关(`settings.memory.autoExtract = false`);打开后每天最多 200 次 cheap 模型调用,只看用户消息与最终回答,不看工具输出                                                                        |
| 预算                  | digest ≤ 400 tokens 且最多 15 条;每轮记忆块 ≤ 1,200 tokens 且不超过模型上下文的 10%,每条 ≤ 80 tokens;设置中可调(digest 100–1,000,记忆块 200–4,000);token 用按字符的保守估算                   |
| `memory.write` 的审批 | 有条件预授权:本轮输入来自主人的直接消息、`sensitivity = 0`、不更替已有的单值画像事实时直接写入并显示可撤销提示;其余情况需要审批。设置中提供「每次都要审批」开关(ADR 0010 第 4 节的条件预授权) |
| 维护任务的调度器      | 用 `croner`(MIT,无依赖);加入前按惯例测 import 后的内存                                                                                                                                        |
| 两次自检              | M2a(PR 1–9)已完成;M2b 为 PR 10–15                                                                                                                                                             |

### 5.2 对补充设计的调整

1. **向量不另建 `memory_vec`**:记忆的向量放进 ADR 0014 的统一表(`embeddings` / `embedding_vec`),以 `(item_id, chunk = 0)` 对应。因此 `memory_facts` **不加** `vec_rowid` 与 `embed_model` 两列,也不需要 `trg_memvec_cleanup`:`items` 硬删除时,外键级联删除 `embeddings`,ADR 0014 的触发器删除向量行。换嵌入模型时的重建也走 ADR 0014 第 4 节。
2. **迁移编号**:补充设计与 M2 方案写的「迁移 0003」已被授权目录占用,记忆 v2 的迁移是 **0007**。
3. **导航树**的类别都是 `source = 'memory'` 的 `category` 条目,用 `source_ref` 识别:
   - 根「记忆」:`memory`;
   - 域:`memory:<domain>`,标题为「工作 / 生活 / 通用」;
   - 类型:`memory:<domain>:<group>`,`group` 为 `semantic`(事实)、`episodic`(经历)、`procedural`(方法)或 `decision`(决策,即 `subtype = 'decision'` 的记忆);
   - 历史版本:`memory:<domain>:<group>:history`,`meta.hidden = true`。
     类别按需创建:只有用到的域与类型才建。被更替(`superseded`)的记忆改挂到同类型下的「历史版本」。计数沿 primary `contains` 边统计,包括历史版本(隐藏只影响默认视图,由 PR 14 的 ItemProvider 与 UI 处理)。
4. **更替**:先把旧记录标为 `superseded` 再插入新记录(第 2 节第 3 条);新记录的 `supersedes_id` 指向旧记录,并建一条非 primary 的 `supersedes` 边(新 → 旧)。
5. **硬删除(忘记)**:删除 `items` 行之前,先把它从导航树上摘下,沿祖先链扣减计数;其余由外键级联完成(来源、反馈、冲突、嵌入与向量)。
6. **新增的列**(只用 `ADD COLUMN`):`supersedes_id`、`decision_state`、`tier`、`importance`、`decay_score`、`pinned`、`valid_from`、`valid_to`、`last_confirmed_at`、`last_accessed_at`、`access_count`、`helpful_count`、`stale_count`、`wrong_count`;`idx_mem_lookup` 改为 `(owner_id, status, tier, mem_type)`。
7. **新表**:`memory_conflicts`、`memory_feedback`、`memory_quarantine`、`memory_digest`、`jobs_state`(维护任务的上次 / 下次运行时间与游标,每个 owner、每个任务一行)。带 `owner_id` 的表都以外键级联到 `owners`。

### 5.3 v1 → v2 数据迁移

迁移 0007 先执行 SQL(加列、建表、换索引),再在同一个事务中执行一段数据迁移(`Migration.data`,与 SQL 一样发布后不得修改):

- 已有记忆:`tier = 'active'`、`decay_score = 1`、`last_confirmed_at = updated_at`;
- 为每个 owner 建导航树,把每条记忆挂到它的类型或历史版本类别下,然后用递归 CTE 重算这棵树的计数;
- 推断更替链:同一 owner、同一单值 `entity_key` 的记录按 `created_at` 排序,每条 `superseded` 记录由紧随其后的那一条更替,补 `supersedes_id` 与 `supersedes` 边。

迁移前自动备份(ADR 0005);迁移前后记忆条数与正文不变,有测试覆盖(用 M1 格式的数据库)。

### 5.4 契约(`packages/shared`)

- 新类型:`Tier`、`TrustQualifier`、`MemoryWriteInput` / `MemoryWriteResult`、`MemoryRetrieveInput` / `MemoryRetrieveResult`、`RetrievedMemory`、`MemoryDigest`、`MemoryFeedbackInput`、`ItemRel`(`contains`、`mentions`、`derived`、`supersedes`、`forked_from`)。
- `Memory` 增加 `tier`、`importance`、`pinned`、`supersedesId`、`lastConfirmedAt`(响应中的新增字段,向后兼容)。
- 新的 AgentEvent `memory-used { runId, ids }`(PR 12 起发送;客户端须忽略未知事件,ADR 0004)。M5a 起增加可选的 `degraded` 与 `omitted`,见 ADR 0017。
- 兼容:`memory.save` / `memory.search` 保留为 `memory.write` / `memory.retrieve` 的别名;`POST /memory/search` 与 `recall()`(#13)行为不变。`MemorySaveInput` / `MemorySaveResult` 保留,`MemoryWriteInput` 在其基础上增加字段。

### 5.5 写入路径(M2 PR 11)

- **凭据检测**是 `packages/memory/src/secrets.ts` 中不依赖任何包的纯函数 `detectCredential`,也以 `@fatcat-ai/memory/secrets` 单独导出,供日志、审批卡片等复用。规则覆盖补充设计第 3 节,另加 URL 中的用户名密码、Stripe / Hugging Face / GitLab 前缀与 HTTP Bearer。语料在 `packages/memory/src/fixtures/credential-corpus.ts`(≥ 60 正例、≥ 60 反例);其中的假密钥在运行时拼出,仓库里没有完整的密钥串。凭据检测针对除 `source` 以外的所有输入字段(`source` 里是 core 填的 ULID)。
- **脱敏**(`sensitive.ts`):Luhn 银行卡号、校验位正确的 18 位身份证号、手机号、详细住址替换为占位文字,sensitivity = 2;生日、家庭成员只标记 sensitivity = 1。病历类关键词暂不处理。
- **entity_key 注册表**(`entity-keys.ts`)含别名(如 `user.city` → `user.location.city`)与键族 `project.<slug>.status|license|stack`、`person.<slug>.relation`;不在表中的键归一为 `x.<key>`,默认 multi。M1 中已存的未登记 `user.*` 键不改。
- **去重**只用 FTS:按词(≥ 3 字符)取同类型 active 记忆为候选,再比较「小写并去掉空白、标点」后的文本;没有可用的词时退回全文相等。
- **更替与冲突**:单值键已有 active 时,值相同(`value` 相等,或规范文本相等)→ 合并;新值 `origin = user_explicit`,或置信度 ≥ 旧值 − 0.1 → 更替(旧值同时设 `valid_to`,决策设为 `superseded`);否则两条都标 `conflicted` 并写 `memory_conflicts(kind = 'entity_value')`。冲突中的键再收到用户明说的新值时直接新建 active,冲突由 PR 14 的冲突列表处理。
- **决策**:`subtype = 'decision'` 的记忆默认 `proposed`;仓储的 `setDecisionState` 只允许补充设计第 3 节第 6 条的迁移。
- **隔离区**:校验失败(`schema_invalid`)、超过 200 字(`too_long`)、来自不可信来源或自动抽取的指令性语句(`untrusted_source`)进 `memory_quarantine`,原始输入先脱敏,保留 14 天。凭据不进隔离区,直接拒存。
- **memory.write 的条件预授权**:`MemoryService.canWriteWithoutApproval` 只看 core 能算出的事实(输入合法、无凭据、sensitivity = 0、不会更替已有的 `user.*` / `pref.*` 单值事实);「本轮来自主人的直接消息」由审批策略的 `untrustedContentSeen` 判断(M2 还没有 IM 渠道)。本轮出现过外部内容时写入一定经过审批,记为 `origin = manual`,并按不可信来源检测指令。
- **设置**(`packages/shared` 的增量字段):`memory.alwaysApprove`(默认 false,打开后关闭条件预授权)、`memory.extractDailyLimit`(0–1000,默认 200)。
- **自动抽取**:`RunManager` 新增 `onTurnFinished` 回调(一轮正常结束后调用);抽取器只把用户消息与助手消息的最后一段文本交给 cheap 模型,每轮最多 3 条,每日配额记在 `jobs_state(job = 'memory.extract')`(按 UTC 日期)。本轮出现过外部内容时,抽取结果只进隔离区(`untrusted_source`),等用户在 PR 14 的隔离区中确认。
- 写入后的「已记住:… [撤销]」提示属于 Web UI,放在 PR 14;撤销即 `DELETE /memory/{id}`。

### 5.6 检索、digest 与每轮上下文(M2 PR 12)

- **三路召回**(每路最多 30 条,`packages/storage/src/memory-read.ts` + `packages/memory/src/retrieve.ts`):
  - **全文**:FTS5 trigram(bm25);没有 ≥ 3 字符的词时整句 `LIKE`。另加**中文二字词召回**:trigram 下整句中文问句几乎命中不了(「我还住在杭州吗」找不到「用户常住杭州」),所以从查询中取不含虚词的相邻两字(「杭州」,最多 8 个,另排除「用户」「现在」等泛词)做 `LIKE`,按命中词数排序,接在 FTS 结果之后。`LIKE` 只扫 active 层。
  - **向量**:ADR 0014 的统一表,多取 90 条再只留记忆;没有 embed 配置档、维度不匹配、接口失败或超过 400 ms(`vectorTimeoutMs`,超时即中止嵌入请求)时跳过这一路。FTS 与图是本地同步查询,所以召回的总耗时由这一路的时限决定(开发计划 M5)。新建记忆(created / superseded / conflicted)写入后排队嵌入(`chunk = 0`),编辑正文后重新排队。
  - **图**:种子 = `scopeItemId` + 标题出现在查询中的非记忆内容条目,沿 `mentions` / `derived` 一跳。
- **融合与重排**按补充设计第 4.2 节:RRF(k = 60,权重 1.0 / 1.0 / 0.7),再乘 `(0.5 + 0.5·confidence) × tierF × (0.7 + 0.3·decay_score) × (pinned ? 1.2 : 1)`。默认只取 active 与 conflicted;`includeSuperseded` 或查询里有「以前 / 之前 / 历史 / previously …」时带上 superseded。archive 层只在 `includeArchive` 或前两层不足 3 条时参与。
- **可信度说明**由 core 按顺序判断:conflicted → 有冲突;`origin = extracted` 且 confidence < 0.6 → 推断;180 天内没确认过或 `stale_count > 0` → 可能过时;其余 → 可靠(补充设计没有规定 0.6–0.8 的非推断记忆,归为可靠)。每条渲染为 `[记忆 m:<id> | 事实 | 置信 0.90 | 用户明说 · 2026-11-01 | 状态:可靠]` 加正文。分数最高的 3 条在预算允许时附「当时你问:… / 我答:…」,摘录取自消息表,先脱敏、各截断到 120 字,含凭据的不显示。
- **预算**:记忆块 ≤ `settings.memory.blockTokens`(默认 1,200)且 ≤ 模型上下文的 10%,每条 ≤ 80 tokens,按分数贪心装填,装不下时注明「另有 N 条相关记忆未展示」。token 按字符保守估算(`packages/memory/src/tokens.ts`,与 agent 的规则相同)。
- **渠道过滤**:`direct`(Web、CLI、API、私聊)允许 sensitivity ≤ 1;`group` 只允许 0。sensitivity 2 只在 direct 渠道且全文命中(用户的话直接问到)时给出。M2 只有 direct。
- **digest**(`digest.ts`):置顶 → `user.*` / `pref.*` 单值事实 → accepted 的决策 → procedural 偏好,然后列出最多 3 个未解决的冲突作为待确认问题;≤ `settings.memory.digestTokens`(默认 400)且最多 15 条;每行带可信度标签,如「用户常住杭州(可靠)」。sensitivity ≥ 1 的记忆不进 digest(digest 是一份缓存,以后的群聊渠道也会用到)。缓存在 `memory_digest`,写入、编辑、删除后防抖 30 秒重建;没有缓存时现建。
- **每轮上下文**:`RunManager` 新增 `memoryContext` 选项。会话第一轮注入 digest,每轮按用户消息检索,记忆块去掉 digest 中已有的条目;两者作为系统消息放在系统提示之后。用到的记忆通过 `memory-used { runId, ids }` 发出。失败时这一轮照常进行。系统提示增加一句:依赖「可能过时 / 有冲突」的记忆前先说明或确认。
- **访问计数**:检索后在内存里合并,每 5 秒批量写入 `access_count + 1`、`last_accessed_at`(每条每次刷新计一次);关闭时立即写入。
- **工具与 REST**:新工具 `memory.retrieve`(read),`memory.search` 是它的别名;有查询时走三路召回并返回可信度说明,查询为空时列出最近的 active 记忆。新增 `POST /memory/retrieve`、`GET /memory/digest`。`POST /memory/search` 不变。
- **#13 `recall()` 的回退**:有查询但没有命中时不再返回最近 20 条;「最近 N 条」只用于空查询(常驻背景由 digest 承担)。
- **业主确认**(2026-11-05):保留中文二字词召回;sensitivity ≥ 1 不进 digest;置信度 0.6–0.8 的非推断记忆标「可靠」;digest 最多滞后 30 秒。
- **性能**(1 万条记忆,本机):`retrieve` P95 21 ms(不含嵌入往返),digest 读取 P95 0.01 ms,digest 重建 5 ms。测量在 `packages/memory/src/retrieve.perf.test.ts`,CI 中按 80 ms / 5 ms 断言。

### 5.7 维护任务(M2 PR 13)

- **任务**(`packages/memory/src/maintenance.ts`):每天依次运行 `memory.decay` → `memory.tier` → `memory.expire`。`memory.sleep` 推迟到 M6(第 5.1 节);`memory.hygiene`、`memory.optimize` 推迟(M2 方案第 7 节)。
  - **decay**:`decay_score = 0.5^(Δt / half_life)`,Δt 取 `max(last_confirmed_at, last_accessed_at)` 至今,都没有时取 `updated_at`。半衰期:episodic 30 天、procedural 180 天、semantic 365 天、done 的决策 90 天。置顶与 `user.*` / `pref.*` 单值事实不衰减(`decay_score = 1`)。只处理 active 与 conflicted。
  - **tier**:active → cold:`decay_score < 0.3` 且 60 天未访问;→ archive:`< 0.1` 且 180 天未访问(满足时可以从 active 直接进 archive)。「未访问」取 `last_accessed_at`,没有时取 `last_confirmed_at` / `updated_at`。进入 archive 时删除嵌入与向量行(`embeddings.removeItem`),保留 FTS。分层只往下走;检索访问到的记忆在批量写访问计数时回到 active,原来在 archive 的重新排队嵌入。
  - **expire**:`status = 'active'` 且 `valid_to < now` 的记录设为 `expired`。
- **执行方式**:每批 500 行一个事务,批之间用 `setImmediate` 让出事件循环。每批之前检查:有对话正在进行(`RunManager.activeRuns > 0`)或 RSS 超过 300 MB 时停下并返回 `postponed`。
- **状态与幂等**:`jobs_state(owner_id, job)` 的 `state_json` 记 `{ day, cursor, done, batches }`(UTC 日期、按 `item_id` 的游标)。同一天已完成的任务直接跳过;推迟或中断后从游标继续;第二天从头开始。`expire` 不需要游标(每批只取仍满足条件的行)。任何任务完成后防抖重建 digest。
- **调度**(`apps/server/src/maintenance-setup.ts`):`croner`(MIT,import 后 heapUsed 约 +0.4 MiB)每天 03:30 运行,用服务器本地时间(1.0 设置中还没有用户时区);推迟时 10 分钟后重试,每天最多 12 次;启动 10 分钟后补跑一次(当天已完成的会跳过)。M6 的通用调度器上线后迁移过去。
- **验收 ②**:「我搬到上海了」后旧值为 superseded,类型类别下默认可见的只有新值,旧值在 `meta.hidden = true` 的「历史版本」下,并能沿 `supersedes` 边(新 → 旧)找到;详情页与默认视图的隐藏由 PR 14 的 ItemProvider 与 UI 呈现。
- **资源**:1 万条记忆上一次 decay + tier + expire 用时约 240 ms,额外 RSS 约 1 MB(目标 < 60 MB),测量在 `packages/memory/src/retrieve.perf.test.ts`。
- **业主确认**(2026-11-05):先按服务器本地时间运行,时区设置以后随调度器一起做;满足归档条件时可以从 active 直接进 archive;启动后 10 分钟的补跑可以早于 03:30。

### 5.8 反馈、记忆 API 与 Web(M2 PR 14)

- **反馈**(`MemoryService.feedback`,补充设计第 6 节),写入 `memory_feedback` 并立即生效;同一条记忆、同一信号、同一 `runId` 只计一次(`ux_memfb_run`,重复时返回 `duplicate`):
  - `helpful`:confidence + 0.05(上限 0.99)、`last_confirmed_at = now`、回到 active;
  - `stale`:confidence − 0.15,`stale_count` 累计到 2 时 active 转 cold;
  - `wrong`:有更正时按更替写入新值(`origin = user_explicit`,沿用原记录的类型、键与域;更正先过凭据检测与脱敏,含凭据时只记反馈不写入);没有更正时撤回(`retracted`、confidence × 0.3);
  - `sensitive`:默认立即硬删除(补充设计中的「提高 sensitivity」选项留到以后)。
- **冲突处理**:`kept_a` / `kept_b` 保留一条,另一条标为 superseded 并挂到历史版本,保留的一条回到 active(冲突期间用户已经明说了新值时,它也进历史版本);`both_valid` 两条都回到 active,单值键改为 multi;`dismissed` 只关闭冲突,两条仍是 conflicted。
- **隔离区提升**:按 `origin = manual` 重新走写入路径(凭据检测、校验、脱敏照常;用户已经确认,不再按不可信来源检测指令);仍然不合法时保留原条目。
- **REST**(`packages/shared` 增量契约:`MemoryFeedbackBody` / `MemoryFeedbackResult`、`MemorySource`、`MemoryConflict`、`ConflictResolveInput`、`QuarantinedMemory`):`POST /memory/{id}/feedback`、`GET /memory/{id}/sources`、`GET /memory/{id}/history`(新版本在前)、`GET /memory/conflicts`、`POST /memory/conflicts/{id}/resolve`、`GET /memory/quarantine`、`POST /memory/quarantine/{id}/promote`。`export` 推迟(M2 方案第 7 节)。
- **审计**:`DELETE /memory/{id}` 写一条 `memory-undo` 审计(只记 id);`?reason=undo`(聊天中的「撤销」)摘要为 `Undid memory …`,否则(记忆页「删除」、即「忘记」)为 `Forgot memory …`。沿用已有的 `memory-undo` 动作,不改 `audit_log` 的 CHECK 约束。`memory.forget` 工具由工具审计记录。
- **工具**:`memory.digest`(read);`memory.feedback`(write,条件预授权恒成立,本轮出现过外部内容时照常审批);`memory.forget`(write,`preauthorizable: false`,每次都要审批,不能「总是允许」)。`ToolDefinition` 新增 `preauthorizable?: false`。
- **memory ItemProvider**(`apps/server/src/memory-provider.ts`):导航树在写入时维护,`sync` 不做事;`open` 返回陈述、可信度、出处与更替历史。记忆现在出现在 `GET /items/roots` 并可以浏览与打开;条目搜索、变更流与给模型的 `items.*` 工具仍然不含记忆(模型通过带渠道过滤的 `memory.*` 工具检索)。`GET /items/{id}/children` 新增 `includeHidden`(默认 false),默认不返回 `meta.hidden` 的子项(「历史版本」);过滤在分页之后,本页可能少于 `limit` 条。
- **Web**:聊天中「本次用到的记忆」面板(来自 `memory-used` 事件,带有用 / 过时 / 错误(可填写更正)/ 不该记);记忆页增加历史、待确认的矛盾与隔离区。
- **业主确认**(2026-11-05):`sensitive` 反馈先保持直接删除,以后再加「只提高敏感级别」;撤销与「忘记」共用 `memory-undo`,靠摘要区分,不重建审计表;分页后再过滤隐藏项可以接受,游标保持可用。
- **M2 PR 15 调整**:中文二字词召回的停用字只保留几乎只作虚词或人称用的字(我、你、您、的、了、吗、呢、吧、啊、呀、么),其余改为按词排除(「他们」「可以」「没有」等)。记忆评测发现原来的停用字会丢掉「过敏」「吉他」这类实词。

### 5.9 生成日志(开发计划 M6,2026-11-10)

对照 TencentDB Agent Memory 的公开设计文档后补入(只读了它的 README 与 API 文档,没有看源码;本节仍是我们自己的规格)。目的:事后能回答「这条 extracted 记忆是哪个模型、哪版提示词抽出来的」,改提示词或换 cheap 模型后知道哪些记忆要复查;失败的抽取也有记录。

- **表**(迁移 0012):`memory_extract_runs(id, owner_id, job, session_id, user_message_id, profile_id, model, prompt_version, status, written, quarantined, refused, error_code, created_at)`。`job` 为 `memory.extract`,以后的 `memory.sleep` 也写这张表;`status` 为 `succeeded` / `failed`。`memory_sources` 加可为空的 `extract_run_id`(外键,`ON DELETE SET NULL`)。`owner_id` 级联删除;会话与消息删除时置空。
- **只记元数据**:不存正文、模型输出或错误信息。`error_code` 只有 `timeout`、`model_error`、`invalid_output`;`prompt_version` 是 `EXTRACT_PROMPT` 的 SHA-256 前 12 位。所以不增加泄露面,凭据检测、脱敏与日志规则都不变。
- **何时写**:每次真正调用了模型才写一行(关闭、超出每日配额、用户消息为空时不写)。模型出错记 `failed` 后照常抛出;输出不是合法 JSON 时记 `failed` / `invalid_output`,输出照旧进隔离区。成功时先写运行行,再写记忆(出处带 `extract_run_id`,去重合并时追加的出处也带),最后补计数:`written`(created / merged / superseded / conflicted)、`quarantined`、`refused`。
- **契约**:`MemorySource` 增加可选字段 `extractRun`(`MemoryExtractRun`:id、job、profileId、model、promptVersion、status、errorCode、createdAt),`GET /memory/{id}/sources` 返回它;手动写入与迁移之前的出处为 null。响应中的新增字段,向后兼容(ADR 0004)。
- **不变的保护**:审批(`memory.write` 的条件预授权与 `alwaysApprove`)、sensitivity 与渠道过滤、本轮出现外部内容时抽取结果只进隔离区、凭据拒存,全部照旧;生成日志只是旁路记录,不参与任何判断。
- **保留**:暂不清理。每天最多 `extractDailyLimit`(默认 200)行,每行几百字节;如需清理,以后随 M6 的通用维护任务一起做。

### 5.10 记忆分层对照(2026-11-10)

外部项目常把记忆分成 L0–L3 四层(TencentDB Agent Memory 的 README 就是这样写的,我们只读了它的公开文档)。我们的数据模型不另建分层表,对应关系如下,以后讨论分层时以此为准:

| 层          | 含义                     | 我们的实现                                                                                                                            |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| L0 原始对话 | 原话、时间、来源         | `messages` 与 `session_summaries`;记忆出处 `memory_sources` 指回用户消息与回答                                                        |
| L1 记忆原子 | 事实、偏好、约束、事件   | `memory_facts`(episodic / semantic / procedural 与 subtype,entity_key、更替链、冲突、可信度、decay / tier)                            |
| L2 场景     | 围绕项目或场景整理的知识 | 尚无。随 M6 的 `memory.sleep` 实现:产物仍是 `memory_facts(origin = 'consolidated')`,用 `derived` 边指回原条目,写入第 5.9 节的生成日志 |
| L3 画像     | 长期、稳定的用户语境     | digest(第 5.6 节):按规则从置顶、`user.*` / `pref.*` 单值事实、已接受的决策和方法类记忆拼出,不由模型生成                               |

两条约束:

1. **L2 不开旁路**:sleep 整理的产物与其他写入一样,走凭据拒存、脱敏、sensitivity 与隔离区;来源中有不可信内容的簇,只把结果放进隔离区。不新增表,不另存模型写的整段文本。
2. **L3 继续按规则生成**:digest 不交给模型改写。这样它可以审计,不会被对话中的注入内容带偏,也不会把 sensitivity ≥ 1 的内容带进缓存(以后的群聊渠道也会用到这份缓存)。

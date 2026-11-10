# ADR 0014 · 嵌入接口、向量表与嵌入队列

- 状态:提议(M2 PR 8)
- 日期:2026-11-04
- 相关:ADR 0005 第 3 节(向量表不放进静态迁移)、ADR 0006(模型网关)、ADR 0007 复审意见 1 / 2、M2 方案 PR 8 与第 7 节

## 背景

知识库(PR 9)与记忆检索(PR 12)都需要向量。M2 方案 PR 8 要求:模型网关新增 `embed(texts)`,只做 OpenAI 兼容的 `/embeddings`(Gemini `batchEmbedContents` 推迟,Anthropic 没有嵌入接口);加载 sqlite-vec;向量表按 embed 配置档的维度创建,换维度时提示用户手动重建(自动重建推迟);嵌入队列并发 1、批量、失败重试、有每日上限。没有 embed 配置档时不加载 sqlite-vec,空闲 RSS 不变。

## 决定

### 1. 模型网关

- `ModelProvider` 增加可选的 `embed(texts, signal) → { vectors: Float32Array[], model, usage? }`。只有 OpenAI 兼容适配实现:`POST {baseURL}/embeddings`,`{ model, input, encoding_format: 'float' }`。
- 每批 1–64 条;按返回的 `index` 排回输入顺序。条数不符、维度不一致或含非有限数时报 `upstream_error`。超时 60 秒,重试与错误脱敏沿用 `http.ts`。
- 选配置档:第一个 `purpose` 含 `embed` 且 `kind = openai-compatible` 的配置档。设置中暂不提供「默认 embed 配置档」(只有一个时不需要;以后增量加入)。

### 2. sqlite-vec

- 依赖 `sqlite-vec` 0.1.9,带各平台预编译扩展(linux x64 / arm64、macOS、Windows x64),由 `packages/storage` 加载。它的 `package.json` 写的是 `MIT OR Apache`(不是合法的 SPDX 标识),上游仓库为 MIT 与 Apache-2.0 双许可,在 `check-licenses` 中按人工核对的例外登记。
- 实测加载扩展只增加约 1 MiB RSS。**只在需要时加载**:配置了 embed 配置档,或者向量表已经存在。后者是必须的:向量表存在时,`embeddings` 上的清理触发器引用 `vec0` 虚拟表,不加载扩展的话 `items` 的删除会失败。因此存储层在打开时只要发现向量表就自动加载。

### 3. 表结构(迁移 0005)与动态向量表

- `embed_queue`:待嵌入的文本(`owner_id`、`item_id` → `items` 级联删除、`chunk`、`text`、`attempts`、`next_attempt_at`、`last_error`),`(item_id, chunk)` 唯一。
- `embeddings`:已嵌入的分块,`id INTEGER PRIMARY KEY` 就是向量表的 `rowid`;同样以 `item_id` 级联删除;保存原文,重建时用它重新入队。
- `embed_state`:单行,记录现有向量表对应的配置档、模型名与维度。
- `embed_usage`:每个 owner 每天(UTC)的嵌入条数。
- 向量表 `embedding_vec`(`vec0(embedding float[N])`)与触发器 `trg_embedding_vec_cleanup`(`AFTER DELETE ON embeddings` 删除对应向量)**不在迁移中**,第一次嵌入成功后按返回的维度创建。级联链为:`items` 硬删除 → 外键删除 `embeddings` / `embed_queue` → 触发器删除向量行(有测试覆盖)。
- 向量表是全局的(1.0 单用户),检索时按 `owner_id` 过滤,并排除软删除的条目。KNN 先取 `4k` 个候选,过滤后取前 `k` 个;距离为 sqlite-vec 默认的 L2。

### 4. 换模型或维度:手动重建

- 配置档的模型名与 `embed_state.model` 不同,或者某次嵌入返回的维度与向量表不同,状态都变为 `rebuild-required`。此时队列不再处理(不消耗额度),检索返回「向量不可用」,由调用方退回 FTS。
- `POST /embeddings/rebuild`:在一个事务中把 `embeddings` 的原文重新放回队列,删除触发器、映射行与向量表,清空 `embed_state`,并重置已放弃的任务;之后按当前配置档的维度重新建表、重新嵌入。重建需要登录与 CSRF。
- 自动后台重建推迟(M2 方案第 7 节)。

### 5. 嵌入队列 worker

- 在主进程中异步运行:嵌入是网络请求,不占 CPU,不需要 `worker_threads`。同一时刻只有一个批次(并发 1),每批最多 32 条。
- 触发时机:入队、配置档新增 / 修改 / 删除、启动时、重试时间到达(定时器 `unref`,不阻止进程退出)。
- 失败:按批次记录脱敏后的错误摘要,退避 1、2、4、8 分钟……最多 1 小时;5 次后不再自动重试,在状态中计为 `failed`,重建时重置。密钥错误(`auth_failed`)不立即重试,等用户修改配置档。
- 每日上限:默认每个 owner 每天 5,000 条,到达后停到下一个 UTC 日。以后放进设置。
- 原文没变的分块重新入队时不做任何事;原文变了就删除旧向量后入队。

### 6. API(`/api/v1` 增量修改)

| 端点                       | 说明                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `GET /embeddings/status`   | `EmbeddingStatus`:状态、配置档与模型、向量表模型与维度、各计数、今日用量 |
| `POST /embeddings/rebuild` | 手动重建,返回重新入队的条数                                              |

Web 设置页显示向量索引状态;需要重建时显示提示与「重建」按钮。PR 8 本身还没有写入方:知识库(PR 9)与记忆(PR 12)调用 `enqueue` 与 `search`。

## 后果

- 没有 embed 配置档的部署不加载 sqlite-vec,空闲内存不变;有配置档时多约 1 MiB。
- 向量表一旦创建,本数据库在别的工具(例如 `sqlite3` 命令行)中删除条目时也需要加载 sqlite-vec,否则会报 `no such module: vec0`。
- 换嵌入模型需要用户点一次重建,并重新消耗嵌入额度。
- 推迟:Gemini `batchEmbedContents`、换维度时的自动后台重建、按设置调整每日上限、默认 embed 配置档的设置项。

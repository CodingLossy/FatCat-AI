# ADR 0005 · 存储:packages/storage、SQLite 连接参数、迁移与备份

- 状态:已采纳(M1 实施方案,业主 2026-11-03 确认)
- 日期:2026-11-03
- 来源:开发计划 3.5、第 12 节;ADR 0001、0003、0007;`docs/milestones/M1-plan.md` 第 4 节

## 背景

server、memory、items 以及以后的渠道、任务都要使用同一个 SQLite 数据库。连接参数(尤其是 `PRAGMA foreign_keys`)、迁移和备份必须只有一处实现,否则外键约束可能在某个连接上悄悄失效。

## 决定

### 1. 新增 `packages/storage`(AGPL-3.0-only)

- 负责:打开连接、执行迁移、在线备份、表的列清单与各领域的仓储(repository)。其他包只依赖它导出的类型化接口,不自己打开数据库。
- 驱动:`better-sqlite3`(同步 API;单进程单写连接,个人规模足够)。Node 内置的 `node:sqlite` 稳定后可替换(另写 ADR)。
- **不使用 ORM**:仓储直接用 better-sqlite3 的预编译语句(全部参数绑定),行类型与列清单写在 `src/schema.ts`。最初选用的 `drizzle-orm` 0.45 仅 `import` 就占用约 140MB 堆内存(本机与 CI 实测,容器空闲 RSS 从 81MB 升到 209MB),超出 2GB 机器的预算与 M0 的 120MB 门禁,已在 PR #3 中移除。
- 迁移:**手写 SQL**,放在 `src/migrations/NNNN_name.ts`(随包编译,不需要额外拷贝文件),由自写的迁移器执行。不用 `drizzle-kit generate`:它无法表达 FTS5 虚拟表、触发器、部分唯一索引和 CHECK 约束,而这些是本项目结构的核心。`src/schema.ts` 的列清单与迁移结果的一致性由单测(列名逐表比对)保证。
- 每条已执行的迁移在 `schema_migrations` 中记录 SHA-256 校验和;启动时发现已执行的迁移被修改,或库中有本版本不认识的迁移,一律拒绝启动。

### 2. 连接参数

每个连接打开后依次执行,并在启动时读回校验:

| PRAGMA         | 值       | 说明                                                                          |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `foreign_keys` | `ON`     | SQLite 默认关闭;读回必须为 1,否则拒绝启动(单测断言)                           |
| `journal_mode` | `WAL`    | 读写并发                                                                      |
| `busy_timeout` | `5000`   | 毫秒                                                                          |
| `synchronous`  | `NORMAL` | WAL 下的常用折中                                                              |
| `cache_size`   | `-4000`  | 页缓存 4 MiB(better-sqlite3 默认 16 MiB,填满后一直占着;M3.x,ADR 0018 第 7 节) |

### 3. 迁移与备份

1. 启动时检查待执行的迁移;如果有,先用 `db.backup()` 在线备份到 `<数据目录>/backups/db-<UTC 时间>-pre-<迁移号>.sqlite`,保留最近 5 份。
2. 在一个事务内顺序执行全部待执行迁移,并写入迁移记录表。
3. 任一步失败:事务回滚,启动中止,日志给出备份文件路径。
4. 需要重建表(例如给已有表加外键列)时,按 SQLite 官方步骤「建新表 → 拷数据 → 删旧表 → 改名」。`PRAGMA foreign_keys` 在事务内修改无效,因此这类迁移标记为 `rebuild`,单独执行:先 `PRAGMA foreign_keys = OFF`,再在它自己的事务内执行迁移并运行 `PRAGMA foreign_key_check`,有违规则回滚,最后恢复 `foreign_keys = ON` 并读回校验。
5. sqlite-vec 的 `vec0` 虚拟表维度取决于用户的 embed 配置档,**不放进静态迁移**;M2 在配置 embed 档后由代码按维度创建,换维度时重建(ADR 0007)。

### 4. 通用列约定

- 主键 `id TEXT`,值为 ULID(时间有序,便于游标分页);事件表例外,用 `seq INTEGER PRIMARY KEY AUTOINCREMENT` 作全局序号(ADR 0004)。
- 时间统一为 ISO-8601 UTC 文本(`created_at`、`updated_at`)。
- 业务表都有 `owner_id TEXT NOT NULL`(1.0 恒为主人 id),为 2.0 多用户预留。
- 外键默认 `ON DELETE CASCADE`(从属数据)或 `ON DELETE SET NULL`(可选引用),在表定义中逐一写明。

### 5. M1 建的表

`owners`、`auth_sessions`、`access_tokens`、`model_profiles`、`settings`、`sessions`(含 `forked_from_session_id` / `forked_from_message_id`,为会话地图预留)、`messages`(含 `parent_message_id`)、`runs`、`events`、`session_summaries`;以及按 ADR 0007 提前建的 `items`、`item_edges`、`items_fts`、`memory_facts`(子集)、`memory_sources`。各表字段见 `docs/milestones/M1-plan.md` 第 4.2 节。

会话与消息表一开始就带上分叉相关的列,M2 就不需要再对这两张表做带外键的 `ALTER TABLE`。

### 6. 事件表体积

运行结束且超过补发窗口(默认 24 小时)后,删除该运行的 `text-delta` 事件(正文已完整保存在 `messages`),只保留结构性事件。不另造「合并后」的事件类型,以免客户端补发时遇到 v1 契约之外的事件。

## 后果

- 外键在所有连接上一致生效,有单测保证;迁移可回滚、有备份。
- `better-sqlite3` 是原生模块:`pnpm` 需把它加入 `onlyBuiltDependencies`,Docker / Windows / arm64 依赖其预编译包。
- 同步 API 会阻塞事件循环:单条查询必须走索引;大批量操作(重算计数、维护任务)分批执行并让出事件循环。

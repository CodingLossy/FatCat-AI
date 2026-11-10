# ADR 0003 · 统一条目索引(知识地图数据模型)

- 状态:已采纳(数据层在 M2 落地;本 ADR 在 M0 先固定契约)
- 日期:2026-11-03
- 来源:开发计划第 6.2 节、4.1.1 节;第 16 节决策 #9

## 背景

邮件、文件 / 文档、小说、人物、会话以及插件数据(如「视频数据」)需要一个统一的、可逐层钻取的浏览入口——「知识地图」。1.0 交付列表 / 树形分类浏览器,M10 桌面端再升级为粒子球钻取导航;两者必须共用同一套数据与 API,避免 M10 返工。

## 决定

### 数据模型(SQLite,`packages/storage` 中的手写 SQL 迁移;查询逻辑在 `packages/items`)

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,            -- ULID
  owner_id TEXT NOT NULL,         -- 1.0 恒为主人 id,为 2.0 多用户预留
  kind TEXT NOT NULL CHECK (kind IN ('category','content')),
  type TEXT NOT NULL,             -- 'mail.folder' | 'mail.message' | 'novel' | 'novel.chapter' | 'character' | 'video.stats' …
  source TEXT NOT NULL,           -- 提供者 id
  source_ref TEXT,                -- 提供者内部引用;UNIQUE(owner_id, source, source_ref)(按 owner 隔离,为 2.0 多用户预留)
  title TEXT NOT NULL, summary TEXT, icon TEXT, color TEXT,
  child_count INTEGER NOT NULL DEFAULT 0,       -- 缓存:直接子项数
  descendant_count INTEGER NOT NULL DEFAULT 0,  -- 缓存:后代条目总数(按 primary 边计)
  meta TEXT,                      -- JSON
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE item_edges (
  parent_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rel TEXT NOT NULL DEFAULT 'contains',   -- 'contains' 构成导航树;'mentions' / 'derived' 为交叉链接
  position INTEGER,
  primary_edge INTEGER NOT NULL DEFAULT 0, -- 每个条目恰有一条 primary 'contains' 边(顶层类别除外)
  PRIMARY KEY (parent_id, child_id, rel)
);
CREATE INDEX idx_edges_child ON item_edges(child_id);
CREATE INDEX idx_items_type ON items(owner_id, type, updated_at);
```

- **外键**:`item_edges` 两端引用 `items(id)` 并 `ON DELETE CASCADE`,与计划 6.2 一致。SQLite 默认不执行外键约束,因此每个数据库连接打开后必须执行 `PRAGMA foreign_keys = ON`(由 M1 的存储模块统一处理,并有测试覆盖:删除条目后其边被级联删除)。
- 硬删除条目时,边由数据库级联删除;祖先链上的 `child_count` / `descendant_count` 仍需在同一事务内由 `packages/items` 更新。日常删除优先使用 `deleted_at` 软删除。

### 规则

- **导航树 = primary `contains` 边**,严格树;写入时检测环并拒绝。非 primary 边让同一条目出现在多个父节点下(UI 显示「也出现在…」)。
- **顶层类别** = `kind='category'` 且无 primary 父边;由各 ItemProvider 的 `roots()` 注册。1.0 内置提供者:`files`、`mail`、`novels`、`characters`、`sessions`;插件经 `registerItemProvider()`(M7)扩展。
- **层级查询**:递归 CTE 沿 primary 边;`child_count` / `descendant_count` 在 upsert / delete 的同一事务内沿祖先链增量更新,另有定期校正任务 `items.recount`。十万级条目不引入闭包表;若基准测试 `ancestors` / `subtree` P95 > 50ms 再引入(另写 ADR)。
- **全文检索**:`items_fts`(FTS5,title + summary),中文用 trigram tokenizer。
- **内容不复制**:条目只存元数据与摘要;正文由提供者在 `open` 时读取,并经权限检查与审计。
- **可见性**:遵循来源权限;未授权目录的文件不登记,撤销授权时级联软删除(`deleted_at`)对应条目。

### 契约(`packages/shared`,M2 加入 zod schema)

```ts
interface Item {
  id: string;
  kind: 'category' | 'content';
  type: string;
  source: string;
  sourceRef?: string;
  title: string;
  summary?: string;
  icon?: string;
  color?: string;
  childCount: number;
  descendantCount: number;
  createdAt: string;
  updatedAt: string;
  meta?: Record<string, unknown>;
}
interface ItemEdge {
  parentId: string;
  childId: string;
  rel: 'contains' | 'mentions' | 'derived';
  position?: number;
  primary: boolean;
}
interface ItemProvider {
  id: string;
  roots(): Promise<ItemInput[]>;
  sync(ctx: ItemSyncContext): AsyncIterable<ItemChange>;
  open(item: Item, ctx: ToolContext): Promise<ItemContent>;
}
```

### REST API(纯 REST,支持 ETag,不依赖 WebSocket)

`GET /api/v1/items/roots`、`/:id`、`/:id/children`(游标分页)、`/:id/ancestors`、`/:id/counts`、`/:id/subtree?depth≤3`、`/:id/related`、`/:id/content`、`/items/search`、`/items/changes`;`POST /api/v1/items/:id/ask`。Agent 工具(risk=read):`items.roots / children / get / search / open`,`open` 返回内容标记为不可信。

## 后果

- 1.0 的 `CategoryBrowser` 与 M10 的 `KnowledgeSphere` 共用同一 API;M10 前复审本 ADR,只做向后兼容的增量修改。
- 必须有的测试:树一致性属性测试(随机增删后计数与递归计算一致、无环)、分页稳定性、权限过滤、10 万条目下 `children` / `ancestors` / `counts` P95 < 50ms。

# ADR 0012 · 条目索引 v1:REST、计数一致性、可见性与内置提供者

- 状态:提议(M2 PR 6 `feat/items-index`,待业主审阅)
- 日期:2026-11-04
- 来源:开发计划 6.2 节、第 8 节 M2;ADR 0003(数据模型,本 ADR 只做补充,不推翻);`docs/milestones/M2-plan.md` 第 2 节 PR 6;ADR 0011(授权目录)
- 契约代码:`packages/shared/src/items.ts`;实现:`packages/storage/src/items.ts`、`packages/items`、`apps/server/src/routes/items.ts`

## 背景

`items` / `item_edges` / `items_fts` 已在 M1 建表(ADR 0003),但还没有计数维护、提供者和 API。M2 PR 6 交付知识地图的数据层与最简的只读树形浏览。验收是「授权一个含小说的文件夹后,可以『小说 → 某书 → 某章』逐层下钻并打开;计数与递归计算一致;树无环;`content` 复用文件工具的权限检查与审计」。

## 决定

### 1. 计数与软删除(`packages/storage/src/items.ts`)

- 计数只统计**未删除**的条目,并且只沿 primary `contains` 边统计:
  - `child_count`:直接子项数;
  - `descendant_count`:后代总数。
- 所有写操作都在一个事务里同时维护祖先链上的计数:
  - **新建**:父项 `child_count + 1`,所有祖先 `descendant_count + 1`。
  - **移动**(换父项):旧祖先减去 `1 + 子树大小`,新祖先加上同样的数。新父项不能是它自己或它的后代,否则拒绝,这就是环检测。
  - **软删除**:整棵子树设置 `deleted_at`,子树内所有计数清零;父项 `child_count - 1`,祖先减去 `1 + 原后代数`。
  - **恢复**:提供者再次同步到同一个 `(source, source_ref)` 时清除 `deleted_at`,按新建处理;它的子项随后在同步中逐个恢复。
- `recount(ownerId)` 用递归 CTE 从叶子重新计算全部计数,返回修正的条数。属性测试用它作为对照。
- 硬删除只用于记忆的「忘记」(ADR 0007):边由外键级联删除。记忆条目在 M2 没有父边,不影响导航树的计数。

### 2. REST(`/api/v1/items`,只读,需鉴权)

| 端点                                                                              | 说明                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /items/roots`                                                                | 顶层类别:`kind='category'`、没有 primary 父边、未删除。按需触发同步(见第 4 节) |
| `GET /items/{id}`                                                                 | 单个条目                                                                       |
| `GET /items/{id}/children?cursor&limit&type&kind&sort=position\|title\|updatedAt` | 直接子项,游标分页;游标包含排序键与 id,翻页期间插入新条目也不会重复或跳过       |
| `GET /items/{id}/ancestors`                                                       | 祖先链(根在前,不含自身),用作面包屑                                             |
| `GET /items/{id}/counts`                                                          | `{ children, descendants, byType }`,`byType` 由递归 CTE 现算                   |
| `GET /items/{id}/subtree?depth≤3&limitPerNode≤50`                                 | 有限深度子树                                                                   |
| `GET /items/{id}/content`                                                         | 打开条目;由提供者读取,见第 5 节                                                |
| `GET /items/search?q&type&under&limit`                                            | FTS(trigram);少于 3 个字符时回退 `LIKE`;`under` 限定在某个子树内               |
| `GET /items/changes?cursor&limit`                                                 | 增量变更(含已删除条目,带 `deletedAt`),按 `(updated_at, id)` 递增               |
| `POST /items/sync`                                                                | 立即同步全部提供者                                                             |

- 已删除的条目只出现在 `/changes` 中;其他端点一律当作不存在(404)。
- 记忆条目(`source='memory'`)在 PR 15 有了 `memory` 提供者之后才进入浏览与搜索,PR 6 中不出现在这些端点里。
- 计划 6.2 中的 `/related` 与 `POST /items/{id}/ask` 不在本 PR:前者在人物与记忆有交叉边之后才有意义,后者随「问 AI」一起做(M5 的分类浏览器)。ETag 也一并放到 M5,本 PR 不做。

### 3. 提供者(`packages/items`)

```ts
interface ItemProvider {
  id: string; // 即 items.source
  sync(ctx: SyncContext): Promise<void>; // 用 ctx.upsert / ctx.removeMissing 写入
  open(item: Item, ctx: OpenContext): Promise<ItemContent>;
}
```

内置三个提供者:

- **`files`**:
  - 结构为「文件」→ 每个授权目录 → 文件夹 → 文件。
  - 遍历时不跟随链接、跳过以 `.` 开头的名称;每个授权目录最多登记 5000 项、深度最多 8 层,超出的部分不登记,并在该目录条目的 `meta.truncated` 中注明。
  - `source_ref` 是 realpath 后的路径。
  - 授权目录被撤销后,对应的子树在下一次同步时软删除(ADR 0011 第 1 节的「级联软删除」在此落实)。
- **`novels`**:
  - 结构为「小说」→ 书 → 章。
  - 识别规则:授权目录内的 `.txt` 文件,文件不超过 20 MB,且至少有 2 行符合章节标题(`第…章 / 回 / 节`、`Chapter N`)。
  - 书名取文件名;章节按标题行切分,标题行之前的内容记为「序」。
  - 编码先按 UTF-8 解码,出现替换字符时改用 GB18030,中文小说常见。
  - 业主 2026-11-04 确认:保持这个识别规则,任何授权目录中章节标题不少于 2 行的 `.txt` 都算小说;按文件夹单独设置「小说目录」留到后续改进。
- **`sessions`**:结构为「会话」→ 每个会话,标题与更新时间来自会话表;打开时返回最近 200 条消息的文本。

### 4. 同步时机

不设常驻的后台任务。以下几种情况会同步,同一 owner 同时只运行一次,失败时记日志、不影响请求:

- `GET /items/roots` 时,如果距离上次同步超过 60 秒,先同步再返回;
- `POST /items/sync`;
- 授权目录增删之后。

### 5. 打开条目与权限

- `files` 与 `novels` 打开时,先用 ADR 0011 第 2 节的路径校验(`resolveInRoots`)确认文件仍在当前的授权目录内,再用 `fs.read` 同一套读取逻辑:文本 256 KB 上限,文档在 worker 中解析。
- 校验失败时,端点返回 403,并按 `denied` 写审计(工具名记为 `items.content`)。成功的读取与 `fs.read` 一样不审计(read 级别)。
- 返回 `ItemContent { format: 'text', content, truncated }`。内容只交给用户自己的 UI;经 Agent 工具交给模型时包成 `UntrustedContent`。

### 6. Agent 工具(全部为 read)

`items.roots`、`items.children`、`items.get`、`items.search`、`items.open`。`items.open` 的输出标为不可信,权限检查与第 5 节相同。

## 后果

- 知识地图数据层在 M2 可用;M5 的分类浏览器与 M10 的粒子球都只读这套 API。
- 大目录只登记前 5000 项;更大规模的索引放到知识库(PR 9)和以后的增量同步(按 mtime)中处理。
- 十万条目的 P95 性能基准放到 M2 收尾(PR 16)统一测量;不达标时再按 ADR 0003 考虑闭包表。

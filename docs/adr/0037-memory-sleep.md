# ADR 0037 · memory.sleep 记忆整理(M6 PR 6)

状态:已采纳(随 PR 6)。依据:`docs/milestones/M6-plan.md` 第 6 节,ADR 0007 第 5.1 / 5.10 节。无数据库迁移、无 API 变化。

## 决定

1. **系统任务 `memory.sleep`**,默认**关闭**(`ensureSystem` 新增 `enabled: false` 种子),每天 04:00(用户时区),`misfire: skip`,在任务页开关。
2. **选材(推荐方案)**:只取 active、`sensitivity = 0`、来源为 `user_explicit` / `extracted` / `manual`、有 `entity_key` 且尚无 `derived` 入边(= 还没被整理)的记忆;隔离区、不可信、高敏感、导入的条目一律不参与。从最近更新的 500 条里选。
3. **聚类**:话题 = `entity_key` 的前两段;同话题 ≥ 3 条成簇(没有用向量,先用最简单可解释的规则;向量聚类留作以后)。
4. **整理**:每簇一次 cheap 模型调用(最多 12 条来源),要求只输出 `{"text": …}`;提示词当数据对待来源文本。
5. **写入**:走同一条 `memory.write`(`origin = consolidated`、`untrusted = true`):凭据拒存、指令性语句进隔离区、脱敏、去重照常;产物 sensitivity 由正文重新计算,来源都是 0,因此不会低于来源。来源条目不改不删;对每个来源建 `derived` 边(产物 → 来源)。
6. **上限**:每次最多 10 次模型调用、新增 20 条;每天 1 次(`jobs_state` 每日名额,手动运行同样占用);没有模型或模型报错的簇记为 refused,不影响其它簇。
7. **生成日志**:每次真正整理写一行 `memory_extract_runs(job = 'memory.sleep')`,含提示词版本与计数,不含正文。

## 未做

向量聚类、`pnpm perf:sleep` 内存测量、记忆页的「撤销整个整理批次」按钮(目前可在记忆页逐条撤回),召回评测对照(计划 6.6)。

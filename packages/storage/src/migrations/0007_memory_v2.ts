// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { newId } from '../ids.js';
import type { Migration } from '../migrate.js';
import type { Sqlite } from '../db.js';

/**
 * 记忆 v2(ADR 0007 第 5 节):只用 ADD COLUMN 与新表,不重建 M1 的表;数据迁移补建导航树、计数与更替链。
 * 向量不在这里:记忆的向量放在 ADR 0014 的统一表中。已发布的迁移(含 data)不得修改。
 */
export const migration0007: Migration = {
    id: 7,
    name: 'memory_v2',
    sql: /* sql */ `
ALTER TABLE memory_facts ADD COLUMN supersedes_id TEXT REFERENCES memory_facts(item_id) ON DELETE SET NULL;
ALTER TABLE memory_facts ADD COLUMN decision_state TEXT
  CHECK (decision_state IN ('proposed','accepted','rejected','done','superseded'));
ALTER TABLE memory_facts ADD COLUMN tier TEXT NOT NULL DEFAULT 'active' CHECK (tier IN ('active','cold','archive'));
ALTER TABLE memory_facts ADD COLUMN importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1);
ALTER TABLE memory_facts ADD COLUMN decay_score REAL NOT NULL DEFAULT 1.0;
ALTER TABLE memory_facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1));
ALTER TABLE memory_facts ADD COLUMN valid_from TEXT;
ALTER TABLE memory_facts ADD COLUMN valid_to TEXT;
ALTER TABLE memory_facts ADD COLUMN last_confirmed_at TEXT;
ALTER TABLE memory_facts ADD COLUMN last_accessed_at TEXT;
ALTER TABLE memory_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_facts ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_facts ADD COLUMN stale_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_facts ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0;

DROP INDEX idx_mem_lookup;
CREATE INDEX idx_mem_lookup ON memory_facts(owner_id, status, tier, mem_type);
CREATE INDEX idx_mem_supersedes ON memory_facts(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE memory_conflicts (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  a_id        TEXT NOT NULL REFERENCES memory_facts(item_id) ON DELETE CASCADE,
  b_id        TEXT NOT NULL REFERENCES memory_facts(item_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('entity_value','semantic_contradiction')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept_a','kept_b','both_valid','dismissed')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_memconf_owner ON memory_conflicts(owner_id, status);
CREATE INDEX idx_memconf_a ON memory_conflicts(a_id);
CREATE INDEX idx_memconf_b ON memory_conflicts(b_id);

CREATE TABLE memory_feedback (
  id         TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL REFERENCES memory_facts(item_id) ON DELETE CASCADE,
  signal     TEXT NOT NULL CHECK (signal IN ('helpful','stale','wrong','sensitive')),
  note       TEXT,
  run_id     TEXT,
  channel    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memfb_mem ON memory_feedback(memory_id);
-- 防刷:同一条记忆、同一信号,每个运行只计一次
CREATE UNIQUE INDEX ux_memfb_run ON memory_feedback(memory_id, signal, run_id) WHERE run_id IS NOT NULL;

-- 无效抽取的隔离区:不进检索,到期清除
CREATE TABLE memory_quarantine (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  raw_json   TEXT NOT NULL,
  reason     TEXT NOT NULL
             CHECK (reason IN ('schema_invalid','secret_detected','low_confidence','untrusted_source','too_long')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_memq_owner ON memory_quarantine(owner_id, expires_at);

-- 会话开头的 digest 缓存:每个 owner 一行
CREATE TABLE memory_digest (
  owner_id       TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  memory_ids     TEXT NOT NULL,
  built_at       TEXT NOT NULL
);

-- 维护任务的运行状态(decay / tier / expire 等)
CREATE TABLE jobs_state (
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  job         TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  state_json  TEXT,
  PRIMARY KEY (owner_id, job)
);

UPDATE memory_facts SET tier = 'active', decay_score = 1.0, last_confirmed_at = updated_at;
`,
    data: backfillMemoryTree,
};

const DOMAIN_TITLES: Record<string, string> = { work: '工作', life: '生活', general: '通用' };
const GROUP_TITLES: Record<string, string> = {
    semantic: '事实',
    episodic: '经历',
    procedural: '方法',
    decision: '决策',
};

/**
 * 为已有记忆建导航树「记忆 → 域 → 类型(→ 历史版本)」,重算这棵树的计数,并推断更替链。
 * 自成一体:不调用仓储,以免以后仓储的修改改变已发布迁移的行为。
 */
function backfillMemoryTree(sqlite: Sqlite, { now }: { now: () => Date }): void {
    const at = now().toISOString();
    const facts = sqlite
        .prepare(
            `SELECT f.item_id AS id, f.owner_id AS ownerId, f.mem_type AS memType, f.subtype, f.domain, f.status,
                    f.entity_key AS entityKey, f.cardinality, f.created_at AS createdAt
             FROM memory_facts f ORDER BY f.created_at, f.item_id`,
        )
        .all() as {
        id: string;
        ownerId: string;
        memType: string;
        subtype: string | null;
        domain: string;
        status: string;
        entityKey: string | null;
        cardinality: string;
        createdAt: string;
    }[];
    if (facts.length === 0) return;

    const findCategory = sqlite.prepare<[string, string], { id: string }>(
        "SELECT id FROM items WHERE owner_id = ? AND source = 'memory' AND source_ref = ?",
    );
    const insertCategory = sqlite.prepare(
        `INSERT INTO items (id, owner_id, kind, type, source, source_ref, title, icon, meta, created_at, updated_at)
         VALUES (@id, @ownerId, 'category', @type, 'memory', @ref, @title, @icon, @meta, @at, @at)`,
    );
    const insertEdge = sqlite.prepare(
        `INSERT INTO item_edges (parent_id, child_id, rel, position, primary_edge) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
    );
    const hasPrimary = sqlite.prepare<[string], { n: number }>(
        "SELECT count(*) AS n FROM item_edges WHERE child_id = ? AND primary_edge = 1 AND rel = 'contains'",
    );

    const category = (
        ownerId: string,
        ref: string,
        parentId: string | null,
        type: string,
        title: string,
        meta: Record<string, unknown> | null = null,
    ): string => {
        const found = findCategory.get(ownerId, ref);
        if (found) return found.id;
        const id = newId(now());
        insertCategory.run({
            id,
            ownerId,
            type,
            ref,
            title,
            icon: parentId ? null : 'brain',
            meta: meta ? JSON.stringify(meta) : null,
            at,
        });
        if (parentId) insertEdge.run(parentId, id, 'contains', null, 1);
        return id;
    };

    const owners = new Set<string>();
    for (const f of facts) {
        owners.add(f.ownerId);
        const root = category(f.ownerId, 'memory', null, 'memory', '记忆');
        const domain = category(
            f.ownerId,
            `memory:${f.domain}`,
            root,
            'memory.domain',
            DOMAIN_TITLES[f.domain] ?? f.domain,
        );
        const group = f.subtype === 'decision' ? 'decision' : f.memType;
        const groupRef = `memory:${f.domain}:${group}`;
        let parent = category(f.ownerId, groupRef, domain, 'memory.group', GROUP_TITLES[group] ?? group);
        if (f.status === 'superseded') {
            parent = category(f.ownerId, `${groupRef}:history`, parent, 'memory.history', '历史版本', {
                hidden: true,
            });
        }
        if ((hasPrimary.get(f.id)?.n ?? 0) === 0) insertEdge.run(parent, f.id, 'contains', null, 1);
    }

    // 更替链:同一单值键按时间排序,每条 superseded 由紧随其后的一条更替
    const setSupersedes = sqlite.prepare('UPDATE memory_facts SET supersedes_id = ? WHERE item_id = ?');
    const byKey = new Map<string, typeof facts>();
    for (const f of facts) {
        if (!f.entityKey || f.cardinality !== 'single') continue;
        const key = `${f.ownerId}\u0000${f.entityKey}`;
        byKey.set(key, [...(byKey.get(key) ?? []), f]);
    }
    for (const chain of byKey.values()) {
        for (let i = 0; i + 1 < chain.length; i++) {
            const older = chain[i]!;
            const newer = chain[i + 1]!;
            if (older.status !== 'superseded') continue;
            setSupersedes.run(older.id, newer.id);
            insertEdge.run(newer.id, older.id, 'supersedes', null, 0);
        }
    }

    // 重算记忆树的计数(只统计未删除的条目、只沿 primary contains 边,与 ADR 0012 第 1 节一致)
    const recount = sqlite.prepare(
        `WITH RECURSIVE d(id) AS (
           SELECT e.child_id FROM item_edges e JOIN items c ON c.id = e.child_id
           WHERE e.parent_id = @root AND e.primary_edge = 1 AND e.rel = 'contains' AND c.deleted_at IS NULL
           UNION ALL
           SELECT e.child_id FROM item_edges e JOIN d ON e.parent_id = d.id JOIN items c ON c.id = e.child_id
           WHERE e.primary_edge = 1 AND e.rel = 'contains' AND c.deleted_at IS NULL
         )
         UPDATE items SET
           descendant_count = (SELECT count(*) FROM d),
           child_count = (SELECT count(*) FROM item_edges e JOIN items c ON c.id = e.child_id
                          WHERE e.parent_id = @root AND e.primary_edge = 1 AND e.rel = 'contains'
                            AND c.deleted_at IS NULL)
         WHERE id = @root`,
    );
    const categories = sqlite.prepare<[string], { id: string }>(
        "SELECT id FROM items WHERE owner_id = ? AND source = 'memory' AND kind = 'category'",
    );
    for (const ownerId of owners) {
        for (const c of categories.all(ownerId)) recount.run({ root: c.id });
    }
}

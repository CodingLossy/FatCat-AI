// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆检索与 digest 的读路径(《记忆模块补充设计》第 4 节;ADR 0007 第 5.6 节)。只读查询加上
// access_count 批量更新与 memory_digest 缓存;融合、重排与渲染在 packages/memory 中。
import type { Memory } from '@fatcat-ai/shared';
import type { Connection } from './db.js';

/** 检索候选:重排与可信度说明需要的全部字段。 */
export interface MemoryCandidate {
    id: string;
    text: string;
    memType: Memory['memType'];
    subtype: Memory['subtype'];
    entityKey: string | null;
    status: Memory['status'];
    tier: NonNullable<Memory['tier']>;
    domain: Memory['domain'];
    sensitivity: number;
    confidence: number;
    importance: number;
    decayScore: number;
    pinned: boolean;
    origin: Memory['origin'];
    decisionState: string | null;
    staleCount: number;
    lastConfirmedAt: string | null;
    updatedAt: string;
}

export interface MemoryExcerpt {
    sessionId: string;
    messageId: string;
    question: string;
    answer: string;
}

export interface StoredDigest {
    body: string;
    tokenEstimate: number;
    ids: string[];
    builtAt: string;
}

export interface OpenConflict {
    id: string;
    aText: string;
    bText: string;
}

const COLUMNS = `f.item_id AS id, i.summary AS text, f.mem_type AS memType, f.subtype, f.entity_key AS entityKey,
    f.status, f.tier, f.domain, f.sensitivity, f.confidence, f.importance, f.decay_score AS decayScore,
    f.pinned, f.origin, f.decision_state AS decisionState, f.stale_count AS staleCount,
    f.last_confirmed_at AS lastConfirmedAt, f.updated_at AS updatedAt`;

type Row = Omit<MemoryCandidate, 'pinned'> & { pinned: number };
const toCandidate = (r: Row): MemoryCandidate => ({ ...r, pinned: r.pinned === 1 });

/** 从消息的 parts_json 中取纯文本。 */
function textOfParts(json: string | null): string {
    if (!json) return '';
    try {
        const parts = JSON.parse(json) as { type?: string; text?: string }[];
        return parts
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
    } catch {
        return '';
    }
}

/** FTS5 查询串:每个 ≥ 3 字符的词作为短语,用 OR 连接;用户输入不会被解析成 FTS 语法。 */
function ftsQuery(query: string): string {
    return query
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(' OR ');
}

/**
 * 几乎只作虚词或人称用的字:含这些字的二字词不用于召回。只放很少的字,
 * 像「他」「过」「会」这样也出现在实词里的字(吉他、过敏、会议)不放进来,改在 STOP_PAIRS 中按词排除。
 */
const STOP_CHARS = new Set('我你您的了吗呢吧啊呀么'.split(''));
/** 几乎每条记忆都有、或问句里常见的二字词。 */
const STOP_PAIRS = new Set([
    '用户',
    '现在',
    '时候',
    '知道',
    '告诉',
    '记得',
    '一下',
    '以前',
    '之前',
    '最近',
    '时间',
    '哪里',
    '哪儿',
    '为何',
    '他们',
    '她们',
    '我们',
    '可以',
    '是不',
    '不是',
    '有没',
    '没有',
    '一个',
    '这个',
    '那个',
    '还是',
    '是否',
    '请问',
    '在哪',
    '怎样',
]);
const CJK_RUN = /[㐀-鿿]+/g;
/** 二字词召回最多使用的词数。 */
const MAX_BIGRAMS = 8;

/**
 * 中文查询的二字词:trigram 分词下整句短语几乎不会命中(「我还住在杭州吗」找不到「用户常住杭州」),
 * 所以另取不含虚词的相邻两字(「杭州」)用 LIKE 召回(ADR 0007 第 5.6 节)。
 */
export function cjkBigrams(query: string): string[] {
    const out: string[] = [];
    for (const run of query.match(CJK_RUN) ?? []) {
        const chars = [...run];
        for (let i = 0; i + 1 < chars.length; i++) {
            const pair = chars[i]! + chars[i + 1]!;
            if (
                STOP_CHARS.has(chars[i]!) ||
                STOP_CHARS.has(chars[i + 1]!) ||
                STOP_PAIRS.has(pair) ||
                out.includes(pair)
            ) {
                continue;
            }
            out.push(pair);
        }
    }
    return out.slice(0, MAX_BIGRAMS);
}

export function createMemoryReadRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    // 二字词召回的语句按词数缓存:命中的词越多排得越前
    const bigramStatements = new Map<
        number,
        ReturnType<typeof sqlite.prepare<[Record<string, unknown>], { id: string }>>
    >();
    const bigramStatement = (n: number) => {
        let stmt = bigramStatements.get(n);
        if (!stmt) {
            const hits = Array.from({ length: n }, (_, i) => `(i.summary LIKE @b${i})`).join(' + ');
            stmt = sqlite.prepare<[Record<string, unknown>], { id: string }>(
                `SELECT id FROM (
                   SELECT f.item_id AS id, (${hits}) AS hits, f.updated_at AS updatedAt
                   FROM memory_facts f JOIN items i ON i.id = f.item_id
                   WHERE f.owner_id = @owner AND i.deleted_at IS NULL AND f.tier = 'active'
                     AND f.status IN (SELECT value FROM json_each(@statuses))
                 ) WHERE hits > 0 ORDER BY hits DESC, updatedAt DESC LIMIT @limit`,
            );
            bigramStatements.set(n, stmt);
        }
        return stmt;
    };
    const q = {
        fts: sqlite.prepare<[string, string, string, number], { id: string }>(
            `SELECT f.item_id AS id FROM items_fts JOIN items i ON i.rowid = items_fts.rowid
             JOIN memory_facts f ON f.item_id = i.id
             WHERE items_fts MATCH ? AND f.owner_id = ? AND i.deleted_at IS NULL
               AND f.status IN (SELECT value FROM json_each(?))
             ORDER BY bm25(items_fts) LIMIT ?`,
        ),
        like: sqlite.prepare<[string, string, string, number], { id: string }>(
            `SELECT f.item_id AS id FROM memory_facts f JOIN items i ON i.id = f.item_id
             WHERE f.owner_id = ? AND i.deleted_at IS NULL AND f.status IN (SELECT value FROM json_each(?))
               AND f.tier = 'active' AND i.summary LIKE ? ESCAPE '\\'
             ORDER BY f.updated_at DESC LIMIT ?`,
        ),
        byIds: sqlite.prepare<[string, string], Row>(
            `SELECT ${COLUMNS} FROM memory_facts f JOIN items i ON i.id = f.item_id
             WHERE f.owner_id = ? AND i.deleted_at IS NULL AND f.item_id IN (SELECT value FROM json_each(?))`,
        ),
        // 图召回的种子:标题出现在查询中的非记忆条目(人物、项目等),只取内容条目
        seeds: sqlite.prepare<[string, string, number], { id: string }>(
            `SELECT id FROM items WHERE owner_id = ? AND source <> 'memory' AND kind <> 'category'
               AND deleted_at IS NULL AND length(title) >= 2 AND instr(?, title) > 0 LIMIT ?`,
        ),
        // mentions / derived 一跳:边的另一端是记忆
        neighbors: sqlite.prepare<[{ seeds: string; owner: string; statuses: string; limit: number }], { id: string }>(
            `SELECT DISTINCT f.item_id AS id FROM item_edges e
             JOIN memory_facts f ON f.item_id = CASE WHEN e.parent_id IN (SELECT value FROM json_each(@seeds))
                                                     THEN e.child_id ELSE e.parent_id END
             WHERE e.rel IN ('mentions','derived')
               AND (e.parent_id IN (SELECT value FROM json_each(@seeds))
                    OR e.child_id IN (SELECT value FROM json_each(@seeds)))
               AND f.owner_id = @owner AND f.status IN (SELECT value FROM json_each(@statuses))
             LIMIT @limit`,
        ),
        excerpt: sqlite.prepare<[string], { sessionId: string; messageId: string; q: string | null; a: string | null }>(
            `SELECT s.session_id AS sessionId, s.user_message_id AS messageId, um.parts_json AS q, am.parts_json AS a
             FROM memory_sources s JOIN messages um ON um.id = s.user_message_id
             LEFT JOIN messages am ON am.id = s.answer_message_id
             WHERE s.memory_id = ? AND s.session_id IS NOT NULL
             ORDER BY s.created_at DESC LIMIT 1`,
        ),
        archived: sqlite.prepare<[string], { id: string; ownerId: string; text: string }>(
            `SELECT f.item_id AS id, f.owner_id AS ownerId, i.summary AS text FROM memory_facts f
             JOIN items i ON i.id = f.item_id
             WHERE f.tier = 'archive' AND f.item_id IN (SELECT value FROM json_each(?))`,
        ),
        // 被访问的记忆回到 active 层(补充设计第 5 节)
        touch: sqlite.prepare<[string, string]>(
            `UPDATE memory_facts SET access_count = access_count + 1, last_accessed_at = ?, tier = 'active'
             WHERE item_id IN (SELECT value FROM json_each(?))`,
        ),
        // digest 候选:置顶 → 画像类单值事实 → accepted 的决策 → procedural 偏好(补充设计第 4.5 节)
        digest: sqlite.prepare<[string, number], Row & { priority: number }>(
            `SELECT * FROM (
               SELECT ${COLUMNS},
                 CASE WHEN f.pinned = 1 THEN 0
                      WHEN f.cardinality = 'single' AND (f.entity_key LIKE 'user.%' OR f.entity_key LIKE 'pref.%') THEN 1
                      WHEN f.subtype = 'decision' AND f.decision_state = 'accepted' THEN 2
                      WHEN f.mem_type = 'procedural' AND f.subtype = 'preference' THEN 3
                      ELSE NULL END AS priority
               FROM memory_facts f JOIN items i ON i.id = f.item_id
               WHERE f.owner_id = ? AND f.status = 'active' AND f.tier <> 'archive' AND i.deleted_at IS NULL
             ) WHERE priority IS NOT NULL
             ORDER BY priority, importance DESC, updatedAt DESC LIMIT ?`,
        ),
        conflicts: sqlite.prepare<[string, number], OpenConflict>(
            `SELECT c.id, ia.summary AS aText, ib.summary AS bText FROM memory_conflicts c
             JOIN items ia ON ia.id = c.a_id JOIN items ib ON ib.id = c.b_id
             WHERE c.owner_id = ? AND c.status = 'open' ORDER BY c.created_at DESC LIMIT ?`,
        ),
        countConflicts: sqlite.prepare<[string], { n: number }>(
            "SELECT count(*) AS n FROM memory_conflicts WHERE owner_id = ? AND status = 'open'",
        ),
        getDigest: sqlite.prepare<[string], { body: string; tokenEstimate: number; ids: string; builtAt: string }>(
            `SELECT body, token_estimate AS tokenEstimate, memory_ids AS ids, built_at AS builtAt
             FROM memory_digest WHERE owner_id = ?`,
        ),
        putDigest: sqlite.prepare(
            `INSERT INTO memory_digest (owner_id, body, token_estimate, memory_ids, built_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner_id) DO UPDATE SET body = excluded.body, token_estimate = excluded.token_estimate,
               memory_ids = excluded.memory_ids, built_at = excluded.built_at`,
        ),
    };

    return {
        /**
         * 全文召回,返回按相关度排好的 id:FTS(bm25)在前,中文二字词的 LIKE 召回接在后面;
         * 没有 ≥ 3 字符的词时整句回退为 LIKE。LIKE 只扫 active 层。
         */
        fts(ownerId: string, query: string, statuses: readonly string[], limit: number): string[] {
            const trimmed = query.trim();
            const match = ftsQuery(trimmed);
            const json = JSON.stringify(statuses);
            const ids: string[] = [];
            if (match) ids.push(...q.fts.all(match, ownerId, json, limit).map((r) => r.id));
            else if (trimmed) {
                const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
                ids.push(...q.like.all(ownerId, json, `%${escaped}%`, limit).map((r) => r.id));
            }
            const bigrams = cjkBigrams(trimmed);
            if (ids.length < limit && bigrams.length > 0) {
                const params: Record<string, unknown> = { owner: ownerId, statuses: json, limit };
                bigrams.forEach((b, i) => (params[`b${i}`] = `%${b}%`));
                const rows = bigramStatement(bigrams.length).all(params);
                for (const { id } of rows) if (!ids.includes(id)) ids.push(id);
            }
            return ids.slice(0, limit);
        },
        /** 图召回:种子条目(显式给出的 + 标题出现在查询中的)沿 mentions / derived 一跳得到的记忆。 */
        graph(ownerId: string, query: string, seedIds: readonly string[], statuses: readonly string[], limit: number) {
            const seeds = [...seedIds, ...q.seeds.all(ownerId, query, 10).map((r) => r.id)];
            if (seeds.length === 0) return [];
            return q.neighbors
                .all({ seeds: JSON.stringify(seeds), owner: ownerId, statuses: JSON.stringify(statuses), limit })
                .map((r) => r.id);
        },
        candidates(ownerId: string, ids: readonly string[]): MemoryCandidate[] {
            if (ids.length === 0) return [];
            return q.byIds.all(ownerId, JSON.stringify(ids)).map(toCandidate);
        },
        /** 最近一条来自对话的出处:当时的用户消息与回答(纯文本,未截断)。 */
        excerpt(memoryId: string): MemoryExcerpt | null {
            const row = q.excerpt.get(memoryId);
            if (!row) return null;
            return {
                sessionId: row.sessionId,
                messageId: row.messageId,
                question: textOfParts(row.q),
                answer: textOfParts(row.a),
            };
        },
        /**
         * access_count + 1、last_accessed_at = now,并回到 active 层(检索后批量调用)。
         * 返回原来在 archive 层的记忆:它们的向量已删除,调用方要重新排队嵌入。
         */
        touch(ids: readonly string[]): { id: string; ownerId: string; text: string }[] {
            if (ids.length === 0) return [];
            const json = JSON.stringify(ids);
            return sqlite.transaction(() => {
                const archived = q.archived.all(json);
                q.touch.run(now().toISOString(), json);
                return archived;
            })();
        },
        digestCandidates(ownerId: string, limit: number): MemoryCandidate[] {
            return q.digest.all(ownerId, limit).map((r) => {
                const row: Row & { priority?: number } = { ...r };
                delete row.priority;
                return toCandidate(row);
            });
        },
        openConflicts(ownerId: string, limit: number): OpenConflict[] {
            return q.conflicts.all(ownerId, limit);
        },
        countOpenConflicts(ownerId: string): number {
            return q.countConflicts.get(ownerId)!.n;
        },
        getDigest(ownerId: string): StoredDigest | null {
            const row = q.getDigest.get(ownerId);
            return row ? { ...row, ids: JSON.parse(row.ids) as string[] } : null;
        },
        putDigest(ownerId: string, digest: StoredDigest): void {
            q.putDigest.run(ownerId, digest.body, digest.tokenEstimate, JSON.stringify(digest.ids), digest.builtAt);
        },
    };
}

export type MemoryReadRepository = ReturnType<typeof createMemoryReadRepository>;

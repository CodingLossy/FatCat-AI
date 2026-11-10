// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆 v1(ADR 0007 的 M1 子集):每条记忆是一个 items 行(source='memory')加一个 memory_facts 行。
// 检索用 items_fts(trigram);少于 3 个字符的查询 trigram 无法命中,回退为 LIKE。
import type { DecisionState, Memory } from '@ai-personal/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import type { ItemRepository } from './items.js';

export interface NewMemory {
    text: string;
    memType: Memory['memType'];
    subtype: Memory['subtype'];
    entityKey: Memory['entityKey'];
    cardinality: Memory['cardinality'];
    value: Memory['value'];
    domain: Memory['domain'];
    sensitivity: number;
    confidence: number;
    origin: Memory['origin'];
    importance?: number | undefined;
    validFrom?: string | null | undefined;
    /** 只对 subtype = 'decision' 有意义;决策默认为 proposed。 */
    decisionState?: Exclude<DecisionState, 'superseded'> | null | undefined;
    source?: {
        sessionId?: string | undefined;
        userMessageId?: string | undefined;
        answerMessageId?: string | undefined;
        itemId?: string | undefined;
        /** 产生这条出处的生成运行(memory_extract_runs)。 */
        extractRunId?: string | undefined;
    };
}

interface Row {
    id: string;
    text: string;
    memType: Memory['memType'];
    subtype: Memory['subtype'];
    entityKey: string | null;
    cardinality: Memory['cardinality'];
    valueJson: string | null;
    status: Memory['status'];
    domain: Memory['domain'];
    sensitivity: number;
    confidence: number;
    origin: Memory['origin'];
    tier: NonNullable<Memory['tier']>;
    importance: number;
    pinned: number;
    supersedesId: string | null;
    decisionState: DecisionState | null;
    lastConfirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export type SaveOutcome =
    | { outcome: 'created' | 'merged'; id: string }
    | { outcome: 'superseded'; id: string; supersededId: string }
    | { outcome: 'conflicted'; id: string; conflictId: string };

export interface MemorySourceRow {
    id: string;
    sessionId: string | null;
    userMessageId: string | null;
    answerMessageId: string | null;
    itemId: string | null;
    excerpt: string | null;
    createdAt: string;
    /** 由模型生成时的那次运行(ADR 0007 第 5.9 节);手动写入或旧数据为 null。 */
    extractRun: ExtractRunSummary | null;
}

/** 记忆生成日志中的一次运行;只有 id、模型、提示词哈希、状态与计数,不含正文或模型输出。 */
export interface ExtractRunSummary {
    id: string;
    job: ExtractRunJob;
    profileId: string | null;
    model: string | null;
    promptVersion: string;
    status: 'succeeded' | 'failed';
    errorCode: string | null;
    createdAt: string;
}

export type ExtractRunJob = 'memory.extract' | 'memory.sleep';

export interface NewExtractRun {
    job: ExtractRunJob;
    sessionId?: string | null | undefined;
    userMessageId?: string | null | undefined;
    profileId?: string | null | undefined;
    model?: string | null | undefined;
    promptVersion: string;
    status: 'succeeded' | 'failed';
    errorCode?: string | null | undefined;
}

export interface ExtractRunCounts {
    written: number;
    quarantined: number;
    refused: number;
}

type SourceQueryRow = Omit<MemorySourceRow, 'extractRun'> & {
    runId: string | null;
    runJob: ExtractRunJob | null;
    runProfileId: string | null;
    runModel: string | null;
    runPromptVersion: string | null;
    runStatus: 'succeeded' | 'failed' | null;
    runErrorCode: string | null;
    runCreatedAt: string | null;
};

export type FeedbackSignal = 'helpful' | 'stale' | 'wrong' | 'sensitive';
export type ConflictResolution = 'kept_a' | 'kept_b' | 'both_valid' | 'dismissed';
/** 沿更替链最多走的步数,防止异常数据造成死循环。 */
const MAX_HISTORY = 100;

export type QuarantineReason =
    'schema_invalid' | 'secret_detected' | 'low_confidence' | 'untrusted_source' | 'too_long';

export interface QuarantineEntry {
    id: string;
    sessionId: string | null;
    raw: unknown;
    reason: QuarantineReason;
    createdAt: string;
    expiresAt: string;
}

export interface MemoryConflict {
    id: string;
    aId: string;
    bId: string;
    kind: 'entity_value' | 'semantic_contradiction';
    status: 'open' | 'kept_a' | 'kept_b' | 'both_valid' | 'dismissed';
    createdAt: string;
}

/** 决策生命周期:proposed → accepted | rejected,accepted → done;任何状态都可以 → superseded(补充设计第 3 节第 6 条)。 */
const DECISION_NEXT: Readonly<Record<DecisionState, readonly DecisionState[]>> = {
    proposed: ['accepted', 'rejected'],
    accepted: ['done'],
    rejected: [],
    done: [],
    superseded: [],
};

/** 隔离区条目默认保留 14 天(补充设计第 2.2 节)。 */
export const QUARANTINE_TTL_DAYS = 14;
const QUARANTINE_MAX_RAW = 4000;

/** 更替的门槛:新值不是用户明说时,置信度不能比旧值低 0.1 以上,否则记为冲突(补充设计第 3 节第 5 条)。 */
const SUPERSEDE_MARGIN = 0.1;

/** 去重用的规范文本:小写,去掉空白、标点与符号。 */
export function dedupKey(text: string): string {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

const SELECT = `SELECT f.item_id AS id, i.summary AS text, f.mem_type AS memType, f.subtype, f.entity_key AS entityKey,
        f.cardinality, f.value_json AS valueJson, f.status, f.domain, f.sensitivity, f.confidence, f.origin,
        f.tier, f.importance, f.pinned, f.supersedes_id AS supersedesId, f.decision_state AS decisionState,
        f.last_confirmed_at AS lastConfirmedAt,
        f.created_at AS createdAt, f.updated_at AS updatedAt
    FROM memory_facts f JOIN items i ON i.id = f.item_id`;

const DOMAIN_TITLES = { work: '工作', life: '生活', general: '通用' } as const;
const GROUP_TITLES = { semantic: '事实', episodic: '经历', procedural: '方法', decision: '决策' } as const;

const TITLE_LENGTH = 40;
const MIN_TRIGRAM_QUERY = 3;

function toMemory(row: Row): Memory {
    return {
        id: row.id,
        text: row.text,
        memType: row.memType,
        subtype: row.subtype,
        entityKey: row.entityKey,
        cardinality: row.cardinality,
        value: row.valueJson === null ? null : (JSON.parse(row.valueJson) as Record<string, unknown>),
        status: row.status,
        domain: row.domain,
        sensitivity: row.sensitivity,
        confidence: row.confidence,
        origin: row.origin,
        tier: row.tier,
        importance: row.importance,
        pinned: row.pinned === 1,
        supersedesId: row.supersedesId,
        lastConfirmedAt: row.lastConfirmedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** FTS5 查询串:按空白切词,每个词作为短语加引号,避免用户输入被解析成 FTS 语法。 */
function ftsQuery(query: string): string {
    return query
        .split(/\s+/)
        .filter((w) => w.length >= MIN_TRIGRAM_QUERY)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(' OR ');
}

export function createMemoryRepository(conn: Connection, now: () => Date, items: ItemRepository) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();

    /** 找到或创建一个记忆类别(ADR 0007 第 5.2 节第 3 条)。 */
    function category(
        ownerId: string,
        ref: string,
        parentId: string | null,
        type: string,
        title: string,
        meta?: Record<string, unknown>,
    ): string {
        const found = items.bySource(ownerId, 'memory', ref);
        if (found) return found.id;
        return items.upsert(ownerId, {
            source: 'memory',
            sourceRef: ref,
            kind: 'category',
            type,
            title,
            icon: parentId ? null : 'brain',
            meta: meta ?? null,
            parentId,
        }).id;
    }

    /** 记忆在导航树中的父类别:记忆 → 域 → 类型(被更替的放进「历史版本」)。 */
    function parentFor(
        ownerId: string,
        m: { domain: Memory['domain']; memType: Memory['memType']; subtype: Memory['subtype']; superseded: boolean },
    ): string {
        const root = category(ownerId, 'memory', null, 'memory', '记忆');
        const domain = category(ownerId, `memory:${m.domain}`, root, 'memory.domain', DOMAIN_TITLES[m.domain]);
        const group = m.subtype === 'decision' ? 'decision' : m.memType;
        const ref = `memory:${m.domain}:${group}`;
        const parent = category(ownerId, ref, domain, 'memory.group', GROUP_TITLES[group]);
        return m.superseded
            ? category(ownerId, `${ref}:history`, parent, 'memory.history', '历史版本', { hidden: true })
            : parent;
    }

    /** 按记忆当前的域、类型与状态重新挂到导航树上。 */
    function place(ownerId: string, row: Row): void {
        items.attach(ownerId, row.id, parentFor(ownerId, { ...row, superseded: row.status === 'superseded' }));
    }

    const q = {
        insertItem: sqlite.prepare(
            `INSERT INTO items (id, owner_id, kind, type, source, title, summary, created_at, updated_at)
             VALUES (@id, @ownerId, 'content', @type, 'memory', @title, @summary, @at, @at)`,
        ),
        insertFact: sqlite.prepare(
            `INSERT INTO memory_facts (item_id, owner_id, mem_type, subtype, entity_key, cardinality, value_json, status,
                                       decision_state, domain, sensitivity, confidence, importance, origin, valid_from,
                                       created_at, updated_at)
             VALUES (@id, @ownerId, @memType, @subtype, @entityKey, @cardinality, @valueJson, @status,
                     @decisionState, @domain, @sensitivity, @confidence, @importance, @origin, @validFrom, @at, @at)`,
        ),
        dupFts: sqlite.prepare<[string, string, string, number], Row>(
            `${SELECT} JOIN items_fts ON items_fts.rowid = i.rowid
             WHERE items_fts MATCH ? AND f.owner_id = ? AND f.mem_type = ? AND f.status = 'active'
               AND i.deleted_at IS NULL LIMIT ?`,
        ),
        supersede: sqlite.prepare(
            `UPDATE memory_facts SET status = 'superseded', valid_to = @at, updated_at = @at,
                    decision_state = CASE WHEN decision_state IS NULL THEN NULL ELSE 'superseded' END
             WHERE item_id = @id`,
        ),
        setDecision: sqlite.prepare('UPDATE memory_facts SET decision_state = ?, updated_at = ? WHERE item_id = ?'),
        insertConflict: sqlite.prepare(
            `INSERT INTO memory_conflicts (id, owner_id, a_id, b_id, kind, status, created_at)
             VALUES (?, ?, ?, ?, 'entity_value', 'open', ?)`,
        ),
        listConflicts: sqlite.prepare<[string, string], MemoryConflict>(
            `SELECT id, a_id AS aId, b_id AS bId, kind, status, created_at AS createdAt FROM memory_conflicts
             WHERE owner_id = ? AND status = ? ORDER BY created_at DESC, id DESC`,
        ),
        insertQuarantine: sqlite.prepare(
            `INSERT INTO memory_quarantine (id, owner_id, session_id, raw_json, reason, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ),
        listQuarantine: sqlite.prepare<[string, string], Omit<QuarantineEntry, 'raw'> & { rawJson: string }>(
            `SELECT id, session_id AS sessionId, raw_json AS rawJson, reason, created_at AS createdAt,
                    expires_at AS expiresAt
             FROM memory_quarantine WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC`,
        ),
        purgeQuarantine: sqlite.prepare('DELETE FROM memory_quarantine WHERE expires_at <= ?'),
        jobState: sqlite.prepare<[string, string], { stateJson: string | null }>(
            'SELECT state_json AS stateJson FROM jobs_state WHERE owner_id = ? AND job = ?',
        ),
        upsertJobState: sqlite.prepare(
            `INSERT INTO jobs_state (owner_id, job, last_run_at, state_json) VALUES (?, ?, ?, ?)
             ON CONFLICT (owner_id, job) DO UPDATE SET last_run_at = excluded.last_run_at, state_json = excluded.state_json`,
        ),
        insertSource: sqlite.prepare(
            `INSERT INTO memory_sources (id, memory_id, session_id, user_message_id, answer_message_id, source_item_id,
                                         extract_run_id, created_at)
             VALUES (@id, @memoryId, @sessionId, @userMessageId, @answerMessageId, @itemId, @runId, @at)`,
        ),
        insertRun: sqlite.prepare(
            `INSERT INTO memory_extract_runs (id, owner_id, job, session_id, user_message_id, profile_id, model,
                                              prompt_version, status, error_code, created_at)
             VALUES (@id, @ownerId, @job, @sessionId, @userMessageId, @profileId, @model, @promptVersion, @status,
                     @errorCode, @at)`,
        ),
        runCounts: sqlite.prepare(
            `UPDATE memory_extract_runs SET written = @written, quarantined = @quarantined, refused = @refused
             WHERE owner_id = @ownerId AND id = @id`,
        ),
        get: sqlite.prepare<[string, string], Row>(`${SELECT} WHERE f.owner_id = ? AND f.item_id = ?`),
        list: sqlite.prepare<[string, number], Row>(
            `${SELECT} WHERE f.owner_id = ? AND f.status IN ('active','conflicted') ORDER BY f.updated_at DESC, f.item_id DESC LIMIT ?`,
        ),
        sameText: sqlite.prepare<[string, string, string], Row>(
            `${SELECT} WHERE f.owner_id = ? AND f.mem_type = ? AND f.status = 'active' AND i.summary = ? LIMIT 1`,
        ),
        activeSingle: sqlite.prepare<[string, string], Row>(
            `${SELECT} WHERE f.owner_id = ? AND f.entity_key = ? AND f.cardinality = 'single' AND f.status = 'active'`,
        ),
        setStatus: sqlite.prepare('UPDATE memory_facts SET status = ?, updated_at = ? WHERE item_id = ?'),
        setSupersedes: sqlite.prepare('UPDATE memory_facts SET supersedes_id = ? WHERE item_id = ?'),
        supersedesEdge: sqlite.prepare(
            `INSERT INTO item_edges (parent_id, child_id, rel, position, primary_edge) VALUES (?, ?, 'supersedes', NULL, 0)
             ON CONFLICT DO NOTHING`,
        ),
        confirmedAt: sqlite.prepare('UPDATE memory_facts SET last_confirmed_at = ? WHERE item_id = ?'),
        confirm: sqlite.prepare(
            'UPDATE memory_facts SET confidence = min(0.99, confidence + 0.05), updated_at = ? WHERE item_id = ?',
        ),
        updateText: sqlite.prepare('UPDATE items SET title = ?, summary = ?, updated_at = ? WHERE id = ?'),
        updateDomain: sqlite.prepare('UPDATE memory_facts SET domain = ?, updated_at = ? WHERE item_id = ?'),
        deleteItem: sqlite.prepare("DELETE FROM items WHERE owner_id = ? AND id = ? AND source = 'memory'"),
        fts: sqlite.prepare<[string, string, number], Row & { rank: number }>(
            `${SELECT} JOIN items_fts ON items_fts.rowid = i.rowid
             WHERE items_fts MATCH ? AND f.owner_id = ? AND f.status IN ('active','conflicted') AND i.deleted_at IS NULL
             ORDER BY bm25(items_fts) LIMIT ?`,
        ),
        like: sqlite.prepare<[string, string, number], Row>(
            `${SELECT} WHERE f.owner_id = ? AND f.status IN ('active','conflicted') AND i.summary LIKE ? ESCAPE '\\'
             ORDER BY f.updated_at DESC LIMIT ?`,
        ),
        // 反馈(补充设计第 6 节)
        insertFeedback: sqlite.prepare(
            `INSERT INTO memory_feedback (id, memory_id, signal, note, run_id, channel, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ),
        helpful: sqlite.prepare(
            `UPDATE memory_facts SET confidence = min(0.99, confidence + 0.05), last_confirmed_at = @at, tier = 'active',
                    helpful_count = helpful_count + 1, updated_at = @at WHERE item_id = @id`,
        ),
        stale: sqlite.prepare(
            `UPDATE memory_facts SET confidence = max(0, confidence - 0.15), stale_count = stale_count + 1,
                    tier = CASE WHEN stale_count + 1 >= 2 AND tier = 'active' THEN 'cold' ELSE tier END, updated_at = @at
             WHERE item_id = @id`,
        ),
        wrong: sqlite.prepare(
            `UPDATE memory_facts SET wrong_count = wrong_count + 1, updated_at = @at,
                    status = CASE WHEN @retract = 1 THEN 'retracted' ELSE status END,
                    confidence = CASE WHEN @retract = 1 THEN confidence * 0.3 ELSE confidence END
             WHERE item_id = @id`,
        ),
        sources: sqlite.prepare<[string, string], SourceQueryRow>(
            `SELECT s.id, s.session_id AS sessionId, s.user_message_id AS userMessageId,
                    s.answer_message_id AS answerMessageId, s.source_item_id AS itemId, s.excerpt, s.created_at AS createdAt,
                    r.id AS runId, r.job AS runJob, r.profile_id AS runProfileId, r.model AS runModel,
                    r.prompt_version AS runPromptVersion, r.status AS runStatus, r.error_code AS runErrorCode,
                    r.created_at AS runCreatedAt
             FROM memory_sources s JOIN memory_facts f ON f.item_id = s.memory_id
             LEFT JOIN memory_extract_runs r ON r.id = s.extract_run_id
             WHERE f.owner_id = ? AND s.memory_id = ? ORDER BY s.created_at DESC, s.id DESC`,
        ),
        supersededBy: sqlite.prepare<[string, string], Row>(`${SELECT} WHERE f.owner_id = ? AND f.supersedes_id = ?`),
        getConflict: sqlite.prepare<[string, string], MemoryConflict>(
            `SELECT id, a_id AS aId, b_id AS bId, kind, status, created_at AS createdAt FROM memory_conflicts
             WHERE owner_id = ? AND id = ?`,
        ),
        resolveConflict: sqlite.prepare('UPDATE memory_conflicts SET status = ?, resolved_at = ? WHERE id = ?'),
        setCardinality: sqlite.prepare('UPDATE memory_facts SET cardinality = ? WHERE item_id = ?'),
        getQuarantine: sqlite.prepare<[string, string, string], Omit<QuarantineEntry, 'raw'> & { rawJson: string }>(
            `SELECT id, session_id AS sessionId, raw_json AS rawJson, reason, created_at AS createdAt,
                    expires_at AS expiresAt
             FROM memory_quarantine WHERE owner_id = ? AND id = ? AND expires_at > ?`,
        ),
        deleteQuarantine: sqlite.prepare('DELETE FROM memory_quarantine WHERE owner_id = ? AND id = ?'),
    };

    function addSource(memoryId: string, source: NewMemory['source'], at: string): void {
        if (!source) return;
        q.insertSource.run({
            id: newId(now()),
            memoryId,
            sessionId: source.sessionId ?? null,
            userMessageId: source.userMessageId ?? null,
            answerMessageId: source.answerMessageId ?? null,
            itemId: source.itemId ?? null,
            runId: source.extractRunId ?? null,
            at,
        });
    }

    /** 去重确认:追加来源,置信度 +0.05(上限 0.99),更新 last_confirmed_at。 */
    function merge(id: string, input: NewMemory): SaveOutcome {
        const at = iso();
        q.confirm.run(at, id);
        q.confirmedAt.run(at, id);
        addSource(id, input.source, at);
        return { outcome: 'merged', id };
    }

    /** 同类型的 active 记忆中找同一条:先用 FTS 取候选,再比较规范文本(补充设计第 3 节第 4 条,只用 FTS)。 */
    function findDuplicate(ownerId: string, input: NewMemory): Row | undefined {
        const key = dedupKey(input.text);
        const words = input.text
            .replace(/[\p{P}\p{S}]+/gu, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= MIN_TRIGRAM_QUERY);
        const candidates = words.length
            ? q.dupFts.all(words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' '), ownerId, input.memType, 10)
            : [];
        const exact = q.sameText.get(ownerId, input.memType, input.text);
        if (exact) candidates.push(exact);
        return candidates.find((c) => dedupKey(c.text) === key);
    }

    function sameValue(old: Row, input: NewMemory): boolean {
        if (old.valueJson !== null && input.value !== null) return old.valueJson === JSON.stringify(input.value);
        return dedupKey(old.text) === dedupKey(input.text);
    }

    function insert(ownerId: string, input: NewMemory, status: 'active' | 'conflicted' = 'active'): string {
        const id = newId(now());
        const at = iso();
        q.insertItem.run({
            id,
            ownerId,
            type: `memory.${input.memType}`,
            title: input.text.slice(0, TITLE_LENGTH),
            summary: input.text,
            at,
        });
        q.insertFact.run({
            id,
            ownerId,
            memType: input.memType,
            subtype: input.subtype,
            entityKey: input.entityKey,
            cardinality: input.cardinality,
            valueJson: input.value === null ? null : JSON.stringify(input.value),
            status,
            decisionState: input.subtype === 'decision' ? (input.decisionState ?? 'proposed') : null,
            domain: input.domain,
            sensitivity: input.sensitivity,
            confidence: input.confidence,
            importance: input.importance ?? 0.5,
            origin: input.origin,
            validFrom: input.validFrom ?? null,
            at,
        });
        addSource(id, input.source, at);
        q.confirmedAt.run(at, id);
        items.attach(ownerId, id, parentFor(ownerId, { ...input, superseded: false }));
        return id;
    }

    return {
        /**
         * 写入一条记忆(补充设计第 3 节第 4–5 条),全部在一个事务里:
         * - 同类型的 active 记忆中已有同一条(FTS 候选 + 规范文本相同)→ merged;
         * - 单值 entity_key 已有 active 值:值相同 → merged;新值是用户明说,或置信度不低于旧值 0.1 以上 → 更替;
         *   否则两条都标为 conflicted 并写入 memory_conflicts;
         * - 其余 → created。
         * 更替时先把旧值标为 superseded 再插入新值(部分唯一索引要求这个顺序,ADR 0007 第 2 节第 3 条),
         * 旧值改挂到「历史版本」,新值的 supersedes_id 指向旧值,并建 supersedes 边(新 → 旧)。
         */
        save(ownerId: string, input: NewMemory): SaveOutcome {
            return sqlite.transaction((): SaveOutcome => {
                const duplicate = findDuplicate(ownerId, input);
                if (duplicate) return merge(duplicate.id, input);
                if (input.entityKey && input.cardinality === 'single') {
                    const old = q.activeSingle.get(ownerId, input.entityKey);
                    if (old && sameValue(old, input)) return merge(old.id, input);
                    if (
                        old &&
                        input.origin !== 'user_explicit' &&
                        input.confidence < old.confidence - SUPERSEDE_MARGIN
                    ) {
                        // 新值把握不够:两条都不是 active,唯一索引不受限制,由用户在 digest / 冲突列表中确认
                        const at = iso();
                        q.setStatus.run('conflicted', at, old.id);
                        const id = insert(ownerId, input, 'conflicted');
                        const conflictId = newId(now());
                        q.insertConflict.run(conflictId, ownerId, old.id, id, at);
                        return { outcome: 'conflicted', id, conflictId };
                    }
                    if (old) {
                        q.supersede.run({ id: old.id, at: iso() });
                        place(ownerId, { ...old, status: 'superseded' });
                        const id = insert(ownerId, input);
                        q.setSupersedes.run(old.id, id);
                        q.supersedesEdge.run(id, old.id);
                        return { outcome: 'superseded', id, supersededId: old.id };
                    }
                }
                return { outcome: 'created', id: insert(ownerId, input) };
            })();
        },
        /** 推进决策状态;不合法的迁移返回 'invalid'(补充设计第 3 节第 6 条)。 */
        setDecisionState(ownerId: string, id: string, next: DecisionState): 'ok' | 'not_found' | 'invalid' {
            const row = q.get.get(ownerId, id);
            if (!row || row.subtype !== 'decision') return 'not_found';
            const from = row.decisionState ?? 'proposed';
            if (next !== 'superseded' && !DECISION_NEXT[from].includes(next)) return 'invalid';
            if (from === 'superseded') return 'invalid';
            q.setDecision.run(next, iso(), id);
            return 'ok';
        },
        /** 单值键当前的 active 记录。 */
        activeFor(ownerId: string, entityKey: string): Memory | null {
            const row = q.activeSingle.get(ownerId, entityKey);
            return row ? toMemory(row) : null;
        },
        decisionState(ownerId: string, id: string): DecisionState | null {
            return q.get.get(ownerId, id)?.decisionState ?? null;
        },
        conflicts(ownerId: string, status: MemoryConflict['status'] = 'open'): MemoryConflict[] {
            return q.listConflicts.all(ownerId, status);
        },
        /** 放进隔离区:不进检索,到期清除。raw 必须已经过凭据检测与脱敏。 */
        quarantine(
            ownerId: string,
            entry: { sessionId?: string | null | undefined; raw: unknown; reason: QuarantineReason },
        ): string {
            const id = newId(now());
            const created = now();
            const expires = new Date(created.getTime() + QUARANTINE_TTL_DAYS * 86_400_000);
            let rawJson = JSON.stringify(entry.raw ?? null);
            if (rawJson.length > QUARANTINE_MAX_RAW)
                rawJson = JSON.stringify({ truncated: rawJson.slice(0, QUARANTINE_MAX_RAW) });
            q.insertQuarantine.run(
                id,
                ownerId,
                entry.sessionId ?? null,
                rawJson,
                entry.reason,
                created.toISOString(),
                expires.toISOString(),
            );
            return id;
        },
        /** 未过期的隔离区条目,最新的在前。 */
        quarantined(ownerId: string): QuarantineEntry[] {
            return q.listQuarantine.all(ownerId, iso()).map(({ rawJson, ...rest }) => ({
                ...rest,
                raw: JSON.parse(rawJson) as unknown,
            }));
        },
        /**
         * 每日配额:当天(UTC)已用次数小于 limit 时占用一次并返回 true,否则返回 false。
         * 计数存在 jobs_state 中(例如自动抽取的每日 cheap 模型调用上限)。
         */
        takeDailySlot(ownerId: string, job: string, limit: number): boolean {
            return sqlite.transaction(() => {
                const at = iso();
                const day = at.slice(0, 10);
                const row = q.jobState.get(ownerId, job);
                const state = row?.stateJson ? (JSON.parse(row.stateJson) as { day?: string; count?: number }) : {};
                const count = state.day === day ? (state.count ?? 0) : 0;
                if (count >= limit) return false;
                q.upsertJobState.run(ownerId, job, at, JSON.stringify({ day, count: count + 1 }));
                return true;
            })();
        },
        /** 删除所有已过期的隔离区条目,返回删除的条数(维护任务调用)。 */
        purgeQuarantine(): number {
            return q.purgeQuarantine.run(iso()).changes;
        },
        /**
         * 记一条反馈并立即生效(补充设计第 6 节);同一条记忆、同一信号,每个运行只计一次(唯一索引)。
         * wrong 默认撤回这条记忆;带更正时由调用方传 retract: false,再用 replace 写入新值。
         * sensitive 只记录,删除由调用方决定。
         */
        feedback(
            ownerId: string,
            id: string,
            signal: FeedbackSignal,
            options: { note?: string | null; runId?: string | null; channel?: string | null; retract?: boolean } = {},
        ): 'ok' | 'duplicate' | 'not_found' {
            return sqlite.transaction((): 'ok' | 'duplicate' | 'not_found' => {
                if (!q.get.get(ownerId, id)) return 'not_found';
                const at = iso();
                try {
                    q.insertFeedback.run(
                        newId(now()),
                        id,
                        signal,
                        options.note ?? null,
                        options.runId ?? null,
                        options.channel ?? null,
                        at,
                    );
                } catch (error) {
                    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return 'duplicate';
                    throw error;
                }
                if (signal === 'helpful') q.helpful.run({ id, at });
                if (signal === 'stale') q.stale.run({ id, at });
                if (signal === 'wrong') q.wrong.run({ id, at, retract: options.retract === false ? 0 : 1 });
                return 'ok';
            })();
        },
        /**
         * 用新内容更替一条指定的记忆(「错误」反馈带更正时):旧记录标为 superseded 并挂到历史版本,
         * 新记录指向旧记录。单值键已有另一条 active 时按普通写入处理(由 save 决定更替或冲突)。
         */
        replace(ownerId: string, oldId: string, input: NewMemory): SaveOutcome | null {
            return sqlite.transaction((): SaveOutcome | null => {
                const old = q.get.get(ownerId, oldId);
                if (!old) return null;
                if (input.entityKey && input.cardinality === 'single') {
                    const active = q.activeSingle.get(ownerId, input.entityKey);
                    if (active && active.id !== oldId) return this.save(ownerId, input);
                }
                q.supersede.run({ id: old.id, at: iso() });
                place(ownerId, { ...old, status: 'superseded' });
                const id = insert(ownerId, input);
                q.setSupersedes.run(old.id, id);
                q.supersedesEdge.run(id, old.id);
                return { outcome: 'superseded', id, supersededId: old.id };
            })();
        },
        /** 出处,最新的在前。 */
        sources(ownerId: string, id: string): MemorySourceRow[] {
            return q.sources
                .all(ownerId, id)
                .map(
                    ({
                        runId,
                        runJob,
                        runProfileId,
                        runModel,
                        runPromptVersion,
                        runStatus,
                        runErrorCode,
                        runCreatedAt,
                        ...s
                    }) => ({
                        ...s,
                        extractRun:
                            runId && runJob && runPromptVersion && runStatus && runCreatedAt
                                ? {
                                      id: runId,
                                      job: runJob,
                                      profileId: runProfileId,
                                      model: runModel,
                                      promptVersion: runPromptVersion,
                                      status: runStatus,
                                      errorCode: runErrorCode,
                                      createdAt: runCreatedAt,
                                  }
                                : null,
                    }),
                );
        },
        /** 记一次生成运行(ADR 0007 第 5.9 节),返回运行 id;计数随后用 setExtractRunCounts 补上。 */
        recordExtractRun(ownerId: string, run: NewExtractRun): string {
            const at = iso();
            const id = newId(now());
            q.insertRun.run({
                id,
                ownerId,
                job: run.job,
                sessionId: run.sessionId ?? null,
                userMessageId: run.userMessageId ?? null,
                profileId: run.profileId ?? null,
                model: run.model ?? null,
                promptVersion: run.promptVersion,
                status: run.status,
                errorCode: run.errorCode ?? null,
                at,
            });
            return id;
        },
        setExtractRunCounts(ownerId: string, id: string, counts: ExtractRunCounts): void {
            q.runCounts.run({ ownerId, id, ...counts });
        },
        /** 更替链:更新的版本在前,然后是这条本身,再往前是更早的版本。 */
        history(ownerId: string, id: string): Memory[] | null {
            const self = q.get.get(ownerId, id);
            if (!self) return null;
            const newer: Row[] = [];
            let cursor: Row | undefined = self;
            while (newer.length < MAX_HISTORY && (cursor = q.supersededBy.get(ownerId, cursor.id)))
                newer.unshift(cursor);
            const older: Row[] = [];
            let prev: Row | undefined = self;
            while (older.length < MAX_HISTORY && prev.supersedesId && (prev = q.get.get(ownerId, prev.supersedesId))) {
                older.push(prev);
            }
            return [...newer, self, ...older].map(toMemory);
        },
        conflict(ownerId: string, id: string): MemoryConflict | null {
            return q.getConflict.get(ownerId, id) ?? null;
        },
        /**
         * 处理冲突:kept_a / kept_b 保留一条(另一条标为 superseded 并挂到历史版本);both_valid 两条都保留
         * (单值键改为 multi);dismissed 只关闭冲突,不改记忆。
         */
        resolveConflict(
            ownerId: string,
            conflictId: string,
            resolution: ConflictResolution,
        ): 'ok' | 'not_found' | 'not_open' {
            return sqlite.transaction((): 'ok' | 'not_found' | 'not_open' => {
                const conflict = q.getConflict.get(ownerId, conflictId);
                if (!conflict) return 'not_found';
                if (conflict.status !== 'open') return 'not_open';
                const at = iso();
                const a = q.get.get(ownerId, conflict.aId);
                const b = q.get.get(ownerId, conflict.bId);
                if (a && b && (resolution === 'kept_a' || resolution === 'kept_b')) {
                    const [winner, loser] = resolution === 'kept_a' ? [a, b] : [b, a];
                    if (loser.status === 'conflicted') {
                        q.supersede.run({ id: loser.id, at });
                        place(ownerId, { ...loser, status: 'superseded' });
                        q.supersedesEdge.run(winner.id, loser.id);
                        if (!winner.supersedesId) q.setSupersedes.run(loser.id, winner.id);
                    }
                    const taken =
                        winner.entityKey && winner.cardinality === 'single'
                            ? q.activeSingle.get(ownerId, winner.entityKey)
                            : undefined;
                    // 冲突期间用户已经明说了新值时,保留的这条也只能进历史版本
                    if (winner.status === 'conflicted') {
                        if (taken && taken.id !== winner.id) {
                            q.supersede.run({ id: winner.id, at });
                            place(ownerId, { ...winner, status: 'superseded' });
                        } else {
                            q.setStatus.run('active', at, winner.id);
                            q.confirmedAt.run(at, winner.id);
                        }
                    }
                }
                if (a && b && resolution === 'both_valid') {
                    for (const m of [a, b]) {
                        if (m.status !== 'conflicted') continue;
                        q.setCardinality.run('multi', m.id);
                        q.setStatus.run('active', at, m.id);
                    }
                }
                q.resolveConflict.run(resolution, at, conflictId);
                return 'ok';
            })();
        },
        quarantineEntry(ownerId: string, id: string): QuarantineEntry | null {
            const row = q.getQuarantine.get(ownerId, id, iso());
            if (!row) return null;
            const { rawJson, ...rest } = row;
            return { ...rest, raw: JSON.parse(rawJson) as unknown };
        },
        deleteQuarantine(ownerId: string, id: string): boolean {
            return q.deleteQuarantine.run(ownerId, id).changes > 0;
        },
        get(ownerId: string, id: string): Memory | null {
            const row = q.get.get(ownerId, id);
            return row ? toMemory(row) : null;
        },
        /** active 与 conflicted 的记忆,最近更新的在前。 */
        list(ownerId: string, limit: number): Memory[] {
            return q.list.all(ownerId, limit).map(toMemory);
        },
        update(
            ownerId: string,
            id: string,
            patch: { text?: string; domain?: Memory['domain']; retract?: boolean },
        ): Memory | null {
            if (!q.get.get(ownerId, id)) return null;
            sqlite.transaction(() => {
                const at = iso();
                if (patch.text !== undefined) q.updateText.run(patch.text.slice(0, TITLE_LENGTH), patch.text, at, id);
                if (patch.domain !== undefined) {
                    q.updateDomain.run(patch.domain, at, id);
                    place(ownerId, q.get.get(ownerId, id)!); // 改了域:挂到新域的同类型下
                }
                if (patch.retract) q.setStatus.run('retracted', at, id);
            })();
            return this.get(ownerId, id);
        },
        /**
         * 「忘记」:先从导航树上摘下(扣减祖先计数),再硬删除条目;记忆、出处、反馈、冲突、嵌入与向量
         * 由外键与触发器级联删除,FTS 由触发器同步(ADR 0007 第 5.2 节第 5 条)。
         */
        delete(ownerId: string, id: string): boolean {
            return sqlite.transaction(() => {
                if (!q.get.get(ownerId, id)) return false;
                items.attach(ownerId, id, null);
                return q.deleteItem.run(ownerId, id).changes > 0;
            })();
        },
        /** 检索:能用 trigram 的查询走 FTS5(bm25 排序),否则回退为 LIKE。score 越大越相关。 */
        search(
            ownerId: string,
            query: string,
            options: { types?: Memory['memType'][] | undefined; limit: number },
        ): (Memory & { score: number })[] {
            const match = ftsQuery(query.trim());
            let rows: (Row & { rank?: number })[];
            if (match) {
                rows = q.fts.all(match, ownerId, options.limit * 3);
            } else {
                const escaped = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
                rows = q.like.all(ownerId, `%${escaped}%`, options.limit * 3);
            }
            return rows
                .filter((r) => !options.types || options.types.includes(r.memType))
                .slice(0, options.limit)
                .map((r, index) => ({ ...toMemory(r), score: Number((1 / (1 + index)).toFixed(4)) }));
        },
    };
}

export interface SessionSummary {
    fromSeq: number;
    toSeq: number;
    summary: string;
}

/** 会话摘要按段保存(from_seq 唯一):每段压缩一段连续的旧消息,原文仍在 messages。 */
export function createSummaryRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], SessionSummary>(
            `SELECT from_seq AS fromSeq, to_seq AS toSeq, summary FROM session_summaries
             WHERE session_id = ? ORDER BY from_seq`,
        ),
        insert: sqlite.prepare(
            `INSERT INTO session_summaries (id, session_id, from_seq, to_seq, summary, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ),
    };
    return {
        list(sessionId: string): SessionSummary[] {
            return q.list.all(sessionId);
        },
        add(sessionId: string, summary: SessionSummary): void {
            q.insert.run(newId(now()), sessionId, summary.fromSeq, summary.toSeq, summary.summary, now().toISOString());
        },
    };
}

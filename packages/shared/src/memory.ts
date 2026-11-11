// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆契约。M1 子集与 M2 的 v2 类型;命名与取值和《记忆模块补充设计》第 8 节一致(ADR 0007 第 5.4 节)。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

export const MemType = z.enum(['episodic', 'semantic', 'procedural']);
export type MemType = z.infer<typeof MemType>;

export const MemSubtype = z.enum(['profile', 'preference', 'decision', 'task', 'relation']);
export const MemStatus = z.enum(['active', 'superseded', 'conflicted', 'retracted', 'expired']);
export type MemStatus = z.infer<typeof MemStatus>;

export const MemDomain = z.enum(['work', 'life', 'general']);
export const MemOrigin = z.enum(['user_explicit', 'extracted', 'consolidated', 'manual', 'imported']);
export const MemCardinality = z.enum(['single', 'multi']);

/** 分层:active 正常参与检索;cold 降权;archive 只在显式要求或结果不足时参与(补充设计第 4.2、5 节)。 */
export const Tier = z.enum(['active', 'cold', 'archive']);
export type Tier = z.infer<typeof Tier>;

export const DecisionState = z.enum(['proposed', 'accepted', 'rejected', 'done', 'superseded']);
export type DecisionState = z.infer<typeof DecisionState>;

/** 规范化键,如 user.location.city;不在注册表中的键归一为 x.<slug>。 */
export const EntityKey = z.string().regex(/^[a-z][a-z0-9_.-]{1,80}$/);

export const MemoryText = z.string().trim().min(2).max(200);

/** memory.save 工具与 POST /api/v1/memory 的输入。 */
export const MemorySaveInput = z.object({
    text: MemoryText,
    memType: MemType.default('semantic'),
    subtype: MemSubtype.optional(),
    entityKey: EntityKey.optional(),
    cardinality: MemCardinality.optional(),
    value: z.record(z.string(), z.unknown()).optional(),
    domain: MemDomain.optional(),
    source: z
        .object({
            sessionId: Id.optional(),
            userMessageId: Id.optional(),
            answerMessageId: Id.optional(),
            itemId: Id.optional(),
        })
        .optional(),
});
export type MemorySaveInput = z.input<typeof MemorySaveInput>;

/** 结果取值与补充设计的 MemoryWriteResult 相同;M1 只会产生 created / merged / superseded / refused。 */
export const MemorySaveResult = z.object({
    outcome: z.enum(['created', 'merged', 'superseded', 'conflicted', 'refused', 'quarantined']),
    id: Id.optional(),
    supersededId: Id.optional(),
    reason: z.enum(['credential', 'schema_invalid', 'untrusted_source', 'too_long']).optional(),
});
export type MemorySaveResult = z.infer<typeof MemorySaveResult>;

export const Memory = z.object({
    id: Id,
    text: MemoryText,
    memType: MemType,
    subtype: MemSubtype.nullable(),
    entityKey: EntityKey.nullable(),
    cardinality: MemCardinality,
    value: z.record(z.string(), z.unknown()).nullable(),
    status: MemStatus,
    domain: MemDomain,
    /** 0 普通、1 个人、2 敏感(已脱敏);凭据一律拒存。 */
    sensitivity: z.number().int().min(0).max(2),
    confidence: z.number().min(0).max(1),
    origin: MemOrigin,
    /** 以下字段自 M2 起提供(ADR 0007 第 5.4 节)。 */
    tier: Tier.optional(),
    importance: z.number().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
    /** 这条记忆更替掉的旧记录。 */
    supersedesId: Id.nullable().optional(),
    lastConfirmedAt: IsoDateTime.nullable().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Memory = z.infer<typeof Memory>;

/** PATCH /api/v1/memory/:id;只能修正文本与分类,或撤回(retracted)。 */
export const MemoryPatch = z.object({
    text: MemoryText.optional(),
    domain: MemDomain.optional(),
    status: z.literal('retracted').optional(),
});
export type MemoryPatch = z.infer<typeof MemoryPatch>;

/** memory.search 工具与 POST /api/v1/memory/search 的输入。 */
export const MemorySearchInput = z.object({
    query: z.string().trim().min(1).max(500),
    types: z.array(MemType).optional(),
    limit: z.number().int().min(1).max(30).default(12),
});
export type MemorySearchInput = z.input<typeof MemorySearchInput>;

export const MemorySearchResult = z.object({
    items: z.array(Memory.extend({ score: z.number() })),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

// ---------- 记忆 v2(M2,补充设计第 8 节;按 zod 4 写法,ADR 0007 第 2 节第 6 条) ----------

/** memory.write 与 POST /api/v1/memory(v2)的输入:在 MemorySaveInput 基础上增加 v2 字段。 */
export const MemoryWriteInput = MemorySaveInput.extend({
    importance: z.number().min(0).max(1).optional(),
    validFrom: IsoDateTime.optional(),
    decisionState: DecisionState.exclude(['superseded']).optional(),
});
export type MemoryWriteInput = z.input<typeof MemoryWriteInput>;

export const MemoryWriteResult = MemorySaveResult.extend({
    conflictId: Id.optional(),
});
export type MemoryWriteResult = z.infer<typeof MemoryWriteResult>;

export const MemoryRetrieveInput = z.object({
    query: z.string().trim().min(1).max(500),
    types: z.array(MemType).optional(),
    domain: MemDomain.optional(),
    includeSuperseded: z.boolean().default(false),
    includeArchive: z.boolean().default(false),
    tokenBudget: z.number().int().min(100).max(4000).default(1200),
    limit: z.number().int().min(1).max(30).default(12),
    /** 知识地图「问 AI」时作为图召回的种子。 */
    scopeItemId: Id.optional(),
});
export type MemoryRetrieveInput = z.input<typeof MemoryRetrieveInput>;

/** 可信度说明:由 core 按固定规则计算,不交给模型判断(补充设计第 4.3 节)。 */
export const TrustQualifier = z.enum(['reliable', 'possibly_stale', 'conflicted', 'inferred']);
export type TrustQualifier = z.infer<typeof TrustQualifier>;

export const RetrievedMemory = z.object({
    id: Id,
    text: z.string(),
    memType: MemType,
    status: MemStatus,
    tier: Tier,
    confidence: z.number().min(0).max(1),
    qualifier: TrustQualifier,
    origin: MemOrigin,
    lastConfirmedAt: IsoDateTime.nullable(),
    score: z.number(),
    channels: z.array(z.enum(['fts', 'vec', 'graph'])),
    /** 出处摘录(分数最高的几条,预算允许时)。 */
    excerpt: z.object({ q: z.string(), a: z.string(), sessionId: Id, messageId: Id }).optional(),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemory>;

/** 召回中没有跑完的一路(ADR 0017 第 2 节)。客户端遇到不认识的值时按「有降级、原因未知」处理。 */
export const MemoryDegradation = z.object({
    /** 召回路径;目前只有 vector 会降级,fts 与 graph 先占位。 */
    path: z.enum(['fts', 'vector', 'graph']),
    /**
     * timeout:超过时限被中止(含 408);auth:嵌入接口返回 401 / 403;
     * rejected:嵌入接口返回其他不可重试的 4xx;error:其余出错(5xx、429、网络、本地查询)。
     */
    reason: z.enum(['timeout', 'auth', 'rejected', 'error']),
});
export type MemoryDegradation = z.infer<typeof MemoryDegradation>;

export const MemoryRetrieveResult = z.object({
    items: z.array(RetrievedMemory),
    /** 已渲染的记忆块(带可信度说明),交给模型时是数据而不是指令。 */
    block: z.string(),
    /** 因预算装不下而没有展示的条数。 */
    omitted: z.number().int().nonnegative(),
    /** 自 M5a 起提供(ADR 0017):没有跑完的召回路径;没有降级时省略。 */
    degraded: z.array(MemoryDegradation).max(3).optional(),
});
export type MemoryRetrieveResult = z.infer<typeof MemoryRetrieveResult>;

export const MemoryDigest = z.object({
    body: z.string(),
    tokenEstimate: z.number().int().nonnegative(),
    ids: z.array(Id),
    openConflicts: z.number().int().nonnegative(),
    builtAt: IsoDateTime,
});
export type MemoryDigest = z.infer<typeof MemoryDigest>;

export const FeedbackSignal = z.enum(['helpful', 'stale', 'wrong', 'sensitive']);
export type FeedbackSignal = z.infer<typeof FeedbackSignal>;

export const MemoryFeedbackInput = z.object({
    id: Id,
    signal: FeedbackSignal,
    /** signal 为 wrong 时可以给出更正后的内容,按更替写入。 */
    correction: MemoryText.optional(),
    runId: Id.optional(),
});
export type MemoryFeedbackInput = z.infer<typeof MemoryFeedbackInput>;

// ---------- 记忆 v2:反馈、出处、历史、冲突与隔离区(M2 PR 14,ADR 0007 第 5.8 节) ----------

/** POST /api/v1/memory/{id}/feedback 的请求体(id 在路径中)。 */
export const MemoryFeedbackBody = MemoryFeedbackInput.omit({ id: true });
export type MemoryFeedbackBody = z.infer<typeof MemoryFeedbackBody>;

export const MemoryFeedbackResult = z.object({
    /**
     * applied:已生效;duplicate:同一运行内已经反馈过;corrected:按更正写入了新值(id 为新记忆);
     * deleted:sensitive 反馈,记忆已硬删除。
     */
    outcome: z.enum(['applied', 'duplicate', 'corrected', 'deleted']),
    id: Id.optional(),
});
export type MemoryFeedbackResult = z.infer<typeof MemoryFeedbackResult>;

/** 一条出处:来自哪个会话的哪条消息,或哪个条目。 */
/**
 * 产生一条出处的生成运行(ADR 0007 第 5.9 节):哪个配置档与模型、哪版提示词(哈希)、成功还是失败。
 * 不含正文或模型输出。
 */
export const MemoryExtractRun = z.object({
    id: Id,
    job: z.enum(['memory.extract', 'memory.sleep']),
    profileId: z.string().nullable(),
    model: z.string().nullable(),
    promptVersion: z.string(),
    status: z.enum(['succeeded', 'failed']),
    errorCode: z.string().nullable(),
    createdAt: IsoDateTime,
});
export type MemoryExtractRun = z.infer<typeof MemoryExtractRun>;

export const MemorySource = z.object({
    id: Id,
    sessionId: Id.nullable(),
    userMessageId: Id.nullable(),
    answerMessageId: Id.nullable(),
    itemId: Id.nullable(),
    excerpt: z.string().nullable(),
    createdAt: IsoDateTime,
    /** 由模型生成时的那次运行;手动写入或迁移 0012 之前的出处为 null(响应中的新增字段)。 */
    extractRun: MemoryExtractRun.nullable().optional(),
});
export type MemorySource = z.infer<typeof MemorySource>;

export const ConflictResolution = z.enum(['kept_a', 'kept_b', 'both_valid', 'dismissed']);
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const MemoryConflict = z.object({
    id: Id,
    kind: z.enum(['entity_value', 'semantic_contradiction']),
    status: z.enum(['open', 'kept_a', 'kept_b', 'both_valid', 'dismissed']),
    createdAt: IsoDateTime,
    a: Memory,
    b: Memory,
});
export type MemoryConflict = z.infer<typeof MemoryConflict>;

export const ConflictResolveInput = z.object({ resolution: ConflictResolution });
export type ConflictResolveInput = z.infer<typeof ConflictResolveInput>;

/** 隔离区条目:raw 是已脱敏的原始输入。 */
export const QuarantinedMemory = z.object({
    id: Id,
    sessionId: Id.nullable(),
    reason: z.enum(['schema_invalid', 'secret_detected', 'low_confidence', 'untrusted_source', 'too_long']),
    raw: z.unknown(),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
});
export type QuarantinedMemory = z.infer<typeof QuarantinedMemory>;

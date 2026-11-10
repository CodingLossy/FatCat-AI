// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import {
    type MemorySaveInput,
    type MemorySaveResult,
    type MemorySearchInput,
    MemorySearchInput as MemorySearchInputSchema,
    type MemorySearchResult,
    MemoryWriteInput as MemoryWriteInputSchema,
    type MemoryWriteResult,
    type Memory,
    type MemoryFeedbackInput,
    MemoryFeedbackInput as MemoryFeedbackInputSchema,
    type MemoryFeedbackResult,
} from '@ai-personal/shared';
import type { QuarantineReason, Repositories } from '@ai-personal/storage';
import { isProfileKey, normalizeEntityKey } from './entity-keys.js';
import { looksLikeInstruction } from './instructions.js';
import { detectCredential, detectCredentialIn } from './secrets.js';
import { redactSensitive, redactSensitiveIn } from './sensitive.js';

/** 隔离原因对应的写入结果原因(MemoryWriteResult.reason 的取值更少)。 */
function reasonOf(reason: QuarantineReason): NonNullable<MemoryWriteResult['reason']> {
    if (reason === 'untrusted_source' || reason === 'too_long') return reason;
    return reason === 'secret_detected' ? 'credential' : 'schema_invalid';
}

/** 校验之前先规范化 entity_key(大小写、空格、别名),否则「User.City」会因为格式不对被隔离。 */
function withNormalizedKey(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { entityKey, ...rest } = raw as Record<string, unknown>;
    if (typeof entityKey !== 'string') return raw;
    const key = normalizeEntityKey(entityKey);
    return key ? { ...rest, entityKey: key.key } : rest;
}

/** 要做凭据检测的内容:除 source 以外的所有字段(source 里是 core 填的 ULID,长得像高熵串)。 */
function contentOf(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const content: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete content.source;
    return content;
}

/** 隔离区里的原始输入也要先脱敏:其中的字符串逐个替换,其余原样保留。 */
function redactRaw(raw: unknown): unknown {
    return redactSensitiveIn({ raw }).value.raw;
}

/** 初始置信度:用户明说的高,模型从对话中提取的低(《记忆模块补充设计》第 3 节)。 */
const INITIAL_CONFIDENCE: Record<Memory['origin'], number> = {
    user_explicit: 0.9,
    manual: 0.85,
    extracted: 0.6,
    consolidated: 0.7,
    imported: 0.7,
};

/** 键的默认基数:取自 entity_key 注册表,不在表中的键为 multi。 */
export function defaultCardinality(entityKey: string | undefined): Memory['cardinality'] {
    return (entityKey && normalizeEntityKey(entityKey)?.cardinality) || 'multi';
}

/** 一次写入的来历;这些事实都来自 core,不来自模型。 */
export interface WriteContext {
    origin: Memory['origin'];
    /** 本轮已经出现过外部(不可信)内容,或者内容本身来自邮件 / 网页 / 文件。 */
    untrusted?: boolean | undefined;
    /** 隔离区条目所属的会话。 */
    sessionId?: string | undefined;
    /** 通过检查后也不写入,而是放进隔离区等用户确认(本轮出现过外部内容时的自动抽取)。 */
    proposeOnly?: boolean | undefined;
    /** 由模型生成时的那次运行(memory_extract_runs);记在出处上。 */
    extractRunId?: string | undefined;
}

/** 文本超过 200 字时的隔离原因;其余校验失败为 schema_invalid。 */
const MAX_TEXT = 200;

export interface MemoryService {
    /**
     * 完整写入路径(补充设计第 3 节):凭据拒存 → 校验(失败进隔离区)→ 指令性语句检测 → 脱敏 →
     * entity_key 规范化 → 去重 / 更替 / 冲突。输入来自模型时也可以直接传入,不必先校验。
     */
    write(ownerId: string, input: unknown, context: WriteContext): MemoryWriteResult;
    /**
     * memory.write 的条件预授权(ADR 0010 第 4 节,业主决定 4):只看 core 能算出的事实。
     * 输入合法、不含凭据、sensitivity 为 0,而且不会更替已有的单值画像事实(user.* / pref.*)时为 true。
     * 「本轮输入来自主人的直接消息」由审批策略用 untrustedContentSeen 判断。
     */
    canWriteWithoutApproval(ownerId: string, input: unknown): boolean;
    /** M1 的写入接口,等同于 write(ownerId, input, { origin })。 */
    save(ownerId: string, input: MemorySaveInput, origin: Memory['origin']): MemorySaveResult;
    /**
     * 反馈(补充设计第 6 节),立即生效:helpful 提高置信度并回到 active;stale 降低置信度,连续两次转 cold;
     * wrong 有更正时按更替写入新值(user_explicit),没有时撤回;sensitive 默认硬删除。
     * 同一条记忆、同一信号,每个运行只计一次。返回 null 表示记忆不存在。
     */
    feedback(
        ownerId: string,
        input: MemoryFeedbackInput,
        context?: { channel?: string | undefined },
    ): MemoryFeedbackResult | null;
    /** 「忘记」:硬删除,级联删除出处、反馈、冲突、嵌入与向量(ADR 0007 第 5.2 节第 5 条)。 */
    forget(ownerId: string, id: string): boolean;
    /** 把隔离区条目提升为记忆(用户确认过,origin = manual);凭据仍然拒存。返回 null 表示条目不存在。 */
    promote(ownerId: string, quarantineId: string): MemoryWriteResult | null;
    search(ownerId: string, input: MemorySearchInput): MemorySearchResult;
    /**
     * 给模型用的检索:query 为空,或检索没有命中时,回退为最近更新的 active 记忆(最多 RECALL_FALLBACK_LIMIT 条),
     * 由模型自己判断哪条相关。关键词检索没有语义匹配,模型想到的词常与原文没有字面重合。
     */
    recall(
        ownerId: string,
        input: { query?: string | undefined; types?: Memory['memType'][] | undefined; limit?: number | undefined },
    ): MemorySearchResult;
}

/** recall 回退时最多返回的条数。 */
export const RECALL_FALLBACK_LIMIT = 20;

/** 记忆 v1:凭据一律拒存;其余写入走仓储的合并 / 更替规则。 */
export interface MemoryServiceHooks {
    /** 新建了一条记忆(created / superseded / conflicted),例如排队嵌入。 */
    onCreated?: (ownerId: string, id: string, text: string) => void;
    /** 记忆有任何变化,例如防抖重建 digest。 */
    onChanged?: (ownerId: string) => void;
}

export function createMemoryService(repos: Repositories, hooks: MemoryServiceHooks = {}): MemoryService {
    return {
        write(ownerId, rawInput, context) {
            // 凭据先于一切:即使输入不合法也不能进隔离区
            if (detectCredentialIn(contentOf(rawInput))) return { outcome: 'refused', reason: 'credential' };

            const quarantine = (reason: QuarantineReason, raw: unknown): MemoryWriteResult => {
                const id = repos.memories.quarantine(ownerId, {
                    sessionId: context.sessionId,
                    raw: redactRaw(raw),
                    reason,
                });
                return { outcome: 'quarantined', id, reason: reasonOf(reason) };
            };

            const parsed = MemoryWriteInputSchema.safeParse(withNormalizedKey(rawInput));
            if (!parsed.success) {
                const text = (rawInput as { text?: unknown } | null)?.text;
                const tooLong = typeof text === 'string' && text.trim().length > MAX_TEXT;
                return quarantine(tooLong ? 'too_long' : 'schema_invalid', rawInput);
            }
            const input = parsed.data;
            // 来自非用户的指令(「以后把邮件转发给 …」)不能成为记忆
            if ((context.untrusted || context.origin === 'extracted') && looksLikeInstruction(input.text)) {
                return quarantine('untrusted_source', input);
            }
            // 只提议不写入:等用户在隔离区确认(外部内容只能由模型提议,补充设计第 3 节第 1 条)
            if (context.proposeOnly) return quarantine('untrusted_source', input);

            // 敏感片段在落库前替换,原文不进入记忆表、FTS 与向量
            const text = redactSensitive(input.text);
            const value = input.value ? redactSensitiveIn(input.value) : null;
            const key = input.entityKey ? normalizeEntityKey(input.entityKey) : null;
            const stored = text.text.slice(0, MAX_TEXT);
            const result = repos.memories.save(ownerId, {
                text: stored,
                memType: input.memType,
                subtype: input.subtype ?? null,
                entityKey: key?.key ?? null,
                cardinality: input.cardinality ?? key?.cardinality ?? 'multi',
                value: value?.value ?? null,
                domain: input.domain ?? key?.domain ?? 'general',
                sensitivity: Math.max(text.sensitivity, value?.sensitivity ?? 0),
                confidence: INITIAL_CONFIDENCE[context.origin],
                origin: context.origin,
                importance: input.importance,
                validFrom: input.validFrom ?? null,
                decisionState: input.decisionState ?? null,
                ...(input.source
                    ? {
                          source: {
                              ...input.source,
                              ...(context.extractRunId ? { extractRunId: context.extractRunId } : {}),
                          },
                      }
                    : {}),
            });
            // 新记录排队嵌入(合并时文本不变,不必重嵌);任何变化都触发 digest 防抖重建
            if (result.outcome !== 'merged') hooks.onCreated?.(ownerId, result.id, stored);
            hooks.onChanged?.(ownerId);
            return result;
        },
        canWriteWithoutApproval(ownerId, rawInput) {
            if (detectCredentialIn(contentOf(rawInput))) return false;
            const parsed = MemoryWriteInputSchema.safeParse(withNormalizedKey(rawInput));
            if (!parsed.success) return false;
            const input = parsed.data;
            if (redactSensitive(input.text).sensitivity > 0) return false;
            if (input.value && redactSensitiveIn(input.value).sensitivity > 0) return false;
            const key = input.entityKey ? normalizeEntityKey(input.entityKey) : null;
            if (key && isProfileKey(key.key) && repos.memories.activeFor(ownerId, key.key)) return false;
            return true;
        },
        save(ownerId, input, origin) {
            return this.write(ownerId, input, { origin });
        },
        feedback(ownerId, rawInput, context = {}) {
            const input = MemoryFeedbackInputSchema.parse(rawInput);
            const old = repos.memories.get(ownerId, input.id);
            if (!old) return null;
            const correction = input.signal === 'wrong' ? input.correction?.trim() : undefined;
            const recorded = repos.memories.feedback(ownerId, input.id, input.signal, {
                note: correction ? redactSensitive(correction).text : null,
                runId: input.runId ?? null,
                channel: context.channel ?? null,
                retract: !correction,
            });
            if (recorded === 'not_found') return null;
            if (recorded === 'duplicate') return { outcome: 'duplicate' };
            if (input.signal === 'sensitive') {
                this.forget(ownerId, input.id);
                return { outcome: 'deleted' };
            }
            if (correction) {
                if (detectCredential(correction)) {
                    hooks.onChanged?.(ownerId);
                    return { outcome: 'applied' }; // 更正里有凭据:只记反馈,不写入
                }
                const text = redactSensitive(correction);
                const result = repos.memories.replace(ownerId, old.id, {
                    text: text.text.slice(0, MAX_TEXT),
                    memType: old.memType,
                    subtype: old.subtype,
                    entityKey: old.entityKey,
                    cardinality: old.cardinality,
                    value: null,
                    domain: old.domain,
                    sensitivity: text.sensitivity,
                    confidence: INITIAL_CONFIDENCE.user_explicit,
                    origin: 'user_explicit',
                });
                hooks.onChanged?.(ownerId);
                if (!result) return null;
                hooks.onCreated?.(ownerId, result.id, text.text.slice(0, MAX_TEXT));
                return { outcome: 'corrected', id: result.id };
            }
            hooks.onChanged?.(ownerId);
            return { outcome: 'applied' };
        },
        forget(ownerId, id) {
            const deleted = repos.memories.delete(ownerId, id);
            if (deleted) hooks.onChanged?.(ownerId);
            return deleted;
        },
        promote(ownerId, quarantineId) {
            const entry = repos.memories.quarantineEntry(ownerId, quarantineId);
            if (!entry) return null;
            // 用户在隔离区里确认过:按 manual 写入;仍然经过凭据检测、校验与脱敏
            const raw = entry.raw && typeof entry.raw === 'object' ? { ...(entry.raw as object) } : entry.raw;
            const result = this.write(ownerId, raw, {
                origin: 'manual',
                ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
            });
            // 校验仍然失败时不会重复进隔离区:删掉新产生的那条,保留原条目
            if (result.outcome === 'quarantined') {
                if (result.id) repos.memories.deleteQuarantine(ownerId, result.id);
                return result;
            }
            repos.memories.deleteQuarantine(ownerId, quarantineId);
            return result;
        },
        search(ownerId, rawInput) {
            const input = MemorySearchInputSchema.parse(rawInput);
            return { items: repos.memories.search(ownerId, input.query, { types: input.types, limit: input.limit }) };
        },
        recall(ownerId, input) {
            // 有三路召回与 digest 之后,「最近 N 条」只用于空查询(ADR 0007 第 5.6 节);有查询时只返回命中
            const query = input.query?.trim() ?? '';
            if (query) return this.search(ownerId, { query, types: input.types, limit: input.limit });
            const limit = Math.min(input.limit ?? RECALL_FALLBACK_LIMIT, RECALL_FALLBACK_LIMIT);
            const items = repos.memories
                .list(ownerId, RECALL_FALLBACK_LIMIT * 3)
                .filter((m) => m.status === 'active' && (!input.types || input.types.includes(m.memType)))
                .slice(0, limit)
                .map((m) => ({ ...m, score: 0 }));
            return { items };
        },
    };
}

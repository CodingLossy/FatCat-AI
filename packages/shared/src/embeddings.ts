// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 嵌入与向量索引的状态(ADR 0014)。
import { z } from 'zod';
import { Id } from './common.js';

/**
 * disabled:没有可用的 embed 配置档(只用 OpenAI 兼容档);ready:正常;
 * rebuild-required:配置档的模型或维度与现有向量表不一致,需要用户手动重建,重建前不再嵌入。
 */
export const EmbeddingState = z.enum(['disabled', 'ready', 'rebuild-required']);
export type EmbeddingState = z.infer<typeof EmbeddingState>;

/** GET /embeddings/status。 */
export const EmbeddingStatus = z.object({
    state: EmbeddingState,
    /** 当前使用的 embed 配置档;没有时为 null。 */
    profileId: Id.nullable(),
    /** 配置档中的模型名。 */
    model: z.string().nullable(),
    /** 现有向量表的模型与维度;还没有建表时为 null。 */
    indexModel: z.string().nullable(),
    dimensions: z.number().int().positive().nullable(),
    queued: z.number().int().nonnegative(),
    /** 重试次数用完、不再自动重试的任务数(重建时重置)。 */
    failed: z.number().int().nonnegative(),
    embedded: z.number().int().nonnegative(),
    /** 今天(UTC)已嵌入的文本条数与每日上限。 */
    today: z.number().int().nonnegative(),
    dailyLimit: z.number().int().positive(),
    /** 最近一次失败的摘要(已脱敏)。 */
    lastError: z.string().nullable(),
});
export type EmbeddingStatus = z.infer<typeof EmbeddingStatus>;

/** POST /embeddings/rebuild 的结果。 */
export const EmbeddingRebuildResult = z.object({ requeued: z.number().int().nonnegative() });
export type EmbeddingRebuildResult = z.infer<typeof EmbeddingRebuildResult>;

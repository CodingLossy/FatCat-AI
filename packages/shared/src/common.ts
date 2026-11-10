// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';

/** ULID:26 位 Crockford Base32,按时间有序(ADR 0005)。 */
export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID');
export type Id = z.infer<typeof Id>;

/** ISO-8601 UTC 时间字符串。 */
export const IsoDateTime = z.iso.datetime();

/** 一次模型调用的 token 用量;部分 OpenAI 兼容端点(如 Ollama)不返回,此时缺省。 */
export const Usage = z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

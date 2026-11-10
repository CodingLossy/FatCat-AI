// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地知识库检索结果(ADR 0015):kb.search 工具的输出,Web 用它显示引用(文件名与页码)。
import { z } from 'zod';
import { Id } from './common.js';

export const KbCitation = z.object({
    /** 引用编号,从 1 开始,与 content 中的 [n] 对应。 */
    n: z.number().int().positive(),
    itemId: Id,
    /** 文件名与真实路径。 */
    file: z.string(),
    path: z.string(),
    /** PDF 页码;其他格式为 null。 */
    page: z.number().int().positive().nullable(),
    /** 片段所在的标题(Markdown 标题或 XLSX 工作表名)。 */
    heading: z.string().nullable(),
});
export type KbCitation = z.infer<typeof KbCitation>;

/** kb.search 的输出:UntrustedContent 加上引用列表。 */
export const KbSearchOutput = z.object({
    untrusted: z.literal(true),
    source: z.object({ kind: z.literal('file'), ref: z.string() }),
    content: z.string(),
    truncated: z.boolean(),
    /** 用到的检索方式:有向量时为 vector,否则为全文检索 fts。 */
    mode: z.enum(['vector', 'fts']),
    citations: z.array(KbCitation),
});
export type KbSearchOutput = z.infer<typeof KbSearchOutput>;

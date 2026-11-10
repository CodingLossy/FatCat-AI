// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

/** 游标分页查询参数;cursor 对客户端不透明(ADR 0004)。 */
export const PageQuery = z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** 分页响应;nextCursor 为 null 表示已到末尾。 */
export function pageOf<T extends z.ZodType>(item: T) {
    return z.object({
        items: z.array(item),
        nextCursor: z.string().nullable(),
    });
}

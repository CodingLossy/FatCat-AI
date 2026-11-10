// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item, ItemContent } from '@fatcat-ai/shared';
import type { ItemInput, Repositories } from '@fatcat-ai/storage';

/** 同步时提供者能用的操作(ADR 0012 第 3 节);写入都经过 storage 的计数维护。 */
export interface SyncContext {
    ownerId: string;
    repos: Repositories;
    /** 当前 owner 的授权目录(已规范化)。 */
    roots: { id: string; path: string; label: string }[];
    upsert(input: Omit<ItemInput, 'source'>): Item;
    /** 父项下本提供者的子项中,不在 keep 里的一律软删除。 */
    removeMissing(parentId: string, keep: ReadonlySet<string>): number;
}

export interface OpenContext {
    ownerId: string;
    repos: Repositories;
    /** 当前 owner 的授权目录(已规范化);打开文件类条目前必须重新校验路径。 */
    roots: string[];
}

/** 条目提供者:把某类数据登记进条目索引,并在打开时读取正文。 */
export interface ItemProvider {
    /** 即 items.source。 */
    id: string;
    sync(ctx: SyncContext): Promise<void>;
    open(item: Item, ctx: OpenContext): Promise<ItemContent>;
}

/** 打开时交给用户 / 模型的正文上限(字符)。 */
export const MAX_CONTENT_CHARS = 60_000;

export function textContent(text: string, limit = MAX_CONTENT_CHARS): ItemContent {
    return { format: 'text', content: text.slice(0, limit), truncated: text.length > limit };
}

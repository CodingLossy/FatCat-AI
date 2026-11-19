// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 增量同步(ADR 0045 第 2 节):手机端缓存会话、消息、条目,用游标拉取自上次以来的变化。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { Item } from './items.js';
import { Message, Session } from './sessions.js';

export const SyncKind = z.enum(['session', 'message', 'item']);
export type SyncKind = z.infer<typeof SyncKind>;

export const MAX_SYNC_LIMIT = 500;

export const SyncQuery = z.object({
    /** 上一次响应的 cursor;不给表示从头开始(完整快照)。 */
    cursor: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SYNC_LIMIT).default(200),
    /** 逗号分隔,如 `session,message`;不给表示三种都要。 */
    kinds: z
        .string()
        .regex(/^(session|message|item)(,(session|message|item))*$/)
        .optional(),
});
export type SyncQuery = z.infer<typeof SyncQuery>;

const base = { id: Id, changedAt: IsoDateTime };

/** 墓碑:该实体已删除(或软删除),客户端应从缓存里移除。 */
export const SyncTombstone = z.object({
    ...base,
    kind: SyncKind,
    deleted: z.literal(true),
    /** 消息墓碑带上所属会话,方便客户端只清理那个会话的缓存。 */
    sessionId: Id.optional(),
});
export const SyncSession = z.object({
    ...base,
    kind: z.literal('session'),
    deleted: z.literal(false),
    session: Session,
});
export const SyncMessage = z.object({
    ...base,
    kind: z.literal('message'),
    deleted: z.literal(false),
    message: Message,
});
export const SyncItem = z.object({ ...base, kind: z.literal('item'), deleted: z.literal(false), item: Item });

export const SyncChange = z.union([SyncTombstone, SyncSession, SyncMessage, SyncItem]);
export type SyncChange = z.infer<typeof SyncChange>;

export const SyncResponse = z.object({
    changes: z.array(SyncChange),
    /** 下次请求带上它;没有新变化时原样返回传入的游标。 */
    cursor: z.string(),
    /** true 表示这一批填满了 limit,还有更多变化,应立刻继续拉取。 */
    hasMore: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

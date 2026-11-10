// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// sessions 提供者:「会话」→ 每个会话(ADR 0012 第 3 节)。
import type { Item, ItemContent } from '@fatcat-ai/shared';
import { type ItemProvider, type OpenContext, type SyncContext, textContent } from './provider.js';

export const SESSIONS_ROOT_REF = 'sessions';
const MAX_SESSIONS = 1000;
const OPEN_MESSAGES = 200;

export const sessionsProvider: ItemProvider = {
    id: 'sessions',
    async sync(ctx: SyncContext) {
        const top = ctx.upsert({
            sourceRef: SESSIONS_ROOT_REF,
            kind: 'category',
            type: 'sessions',
            title: '会话',
            icon: 'chat',
            parentId: null,
        });
        const keep = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = ctx.repos.sessions.list(ctx.ownerId, { limit: 200, ...(cursor ? { cursor } : {}) });
            for (const s of page.items) {
                if (keep.size >= MAX_SESSIONS) break;
                keep.add(s.id);
                ctx.upsert({
                    sourceRef: s.id,
                    kind: 'content',
                    type: 'session',
                    title: s.title || 'Untitled session',
                    meta: { sessionId: s.id, lastMessageAt: s.lastMessageAt },
                    parentId: top.id,
                });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor && keep.size < MAX_SESSIONS);
        ctx.removeMissing(top.id, keep);
    },
    async open(item: Item, ctx: OpenContext): Promise<ItemContent> {
        if (item.type !== 'session' || !item.sourceRef) return textContent(item.title);
        const page = ctx.repos.messages.list(ctx.ownerId, item.sourceRef, { limit: OPEN_MESSAGES });
        const lines = page.items.map((m) => {
            const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
            return `${m.role}: ${text}`;
        });
        return textContent(lines.join('\n\n'));
    },
};

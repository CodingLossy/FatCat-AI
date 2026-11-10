// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// memory 条目提供者(《记忆模块补充设计》第 7 节;ADR 0007 第 5.8 节):导航树「记忆 → 域 → 类型(→ 历史版本)」
// 在写入时由 storage 在同一事务里维护,所以 sync 不需要做事;open 返回陈述、可信度说明、出处与更替历史。
import { filesProvider, type ItemProvider, novelsProvider, sessionsProvider, textContent } from '@fatcat-ai/items';
import { mailProvider } from '@fatcat-ai/mail';
import { qualify } from '@fatcat-ai/memory';
import type { Item, ItemContent } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';

const QUALIFIER = { reliable: '可靠', possibly_stale: '可能过时', conflicted: '有冲突', inferred: '推断' } as const;
const STATUS = {
    active: '当前',
    superseded: '已被更替',
    conflicted: '有冲突',
    retracted: '已撤回',
    expired: '已过期',
} as const;

function render(repos: Repositories, ownerId: string, item: Item): string | null {
    const m = repos.memories.get(ownerId, item.id);
    if (!m) return null;
    const candidate = repos.memoryRead.candidates(ownerId, [m.id])[0];
    const lines = [m.text, ''];
    const qualifier = candidate ? QUALIFIER[qualify(candidate, new Date())] : '';
    lines.push(
        `状态:${STATUS[m.status]}${qualifier ? ` · 可信度:${qualifier}` : ''} · 置信 ${m.confidence.toFixed(2)} · 来源 ${m.origin}`,
    );
    if (m.lastConfirmedAt) lines.push(`最近确认:${m.lastConfirmedAt.slice(0, 10)}`);
    const sources = repos.memories.sources(ownerId, m.id);
    if (sources.length > 0) {
        lines.push('', '出处:');
        for (const s of sources.slice(0, 10)) {
            const where = s.sessionId ? `会话 ${s.sessionId}` : s.itemId ? `条目 ${s.itemId}` : '手动';
            lines.push(`- ${s.createdAt.slice(0, 10)} ${where}${s.excerpt ? `:${s.excerpt}` : ''}`);
        }
    }
    const history = repos.memories.history(ownerId, m.id) ?? [];
    if (history.length > 1) {
        lines.push('', '更替历史(新 → 旧):');
        for (const h of history) lines.push(`- ${h.id === m.id ? '▶ ' : ''}${h.text}(${STATUS[h.status]})`);
    }
    return lines.join('\n');
}

export function createMemoryProvider(): ItemProvider {
    return {
        id: 'memory',
        // 记忆的导航树在写入、更替与删除时同步维护,不需要另外同步
        sync: () => Promise.resolve(),
        open(item: Item, ctx): Promise<ItemContent> {
            if (item.kind === 'category') return Promise.resolve(textContent(item.title));
            const text = render(ctx.repos, ctx.ownerId, item);
            return Promise.resolve(textContent(text ?? item.title));
        },
    };
}

/** 服务器使用的全部条目提供者:items 包自带的三个,加上 memory。 */
export function itemProviders(): ItemProvider[] {
    return [filesProvider, novelsProvider, sessionsProvider, createMemoryProvider(), mailProvider];
}

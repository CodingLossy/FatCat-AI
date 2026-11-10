// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Message } from '@ai-personal/client';
import { connect, parse, table } from '../common.js';
import { type Ctx, UsageError } from '../io.js';

const USAGE = 'Usage: ai-personal sessions list [--limit n] | sessions show <id>';

function textOf(message: Message): string {
    return message.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'tool-call' ? `[tool ${p.name}]` : ''))
        .filter(Boolean)
        .join('');
}

export async function sessionsCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, { limit: { type: 'string' }, json: { type: 'boolean' } });
    const { client } = connect(ctx, values.server);

    if (sub === 'list') {
        const limit = values.limit === undefined ? 20 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError('--limit must be 1-200');
        const { items } = await client.sessions.list({ limit });
        if (values.json) {
            ctx.stdout.write(`${JSON.stringify(items)}\n`);
            return 0;
        }
        if (items.length === 0) {
            ctx.stderr.write('No sessions yet\n');
            return 0;
        }
        table(ctx, [
            ['ID', 'UPDATED', 'TITLE'],
            ...items.map((s) => [s.id, (s.lastMessageAt ?? s.updatedAt).slice(0, 16).replace('T', ' '), s.title]),
        ]);
        return 0;
    }

    if (sub === 'show') {
        const id = positionals[0];
        if (!id) throw new UsageError(USAGE);
        const session = await client.sessions.get(id);
        const messages: Message[] = [];
        let cursor: string | undefined;
        do {
            const page = await client.sessions.messages(id, { limit: 200, ...(cursor ? { cursor } : {}) });
            messages.push(...page.items);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (values.json) {
            ctx.stdout.write(`${JSON.stringify({ session, messages })}\n`);
            return 0;
        }
        ctx.stderr.write(`# ${session.title || session.id}\n`);
        // 被重新生成替代的旧回复不显示
        const replaced = new Set(messages.map((m) => m.parentMessageId).filter(Boolean));
        for (const m of messages) {
            if (replaced.has(m.id)) continue;
            const flag = m.status === 'complete' ? '' : ` (${m.status})`;
            ctx.stdout.write(`${m.role}${flag}: ${textOf(m)}\n`);
        }
        return 0;
    }

    throw new UsageError(USAGE);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { connect, parse, table } from '../common.js';
import { type Ctx, status, UsageError } from '../io.js';

const USAGE = [
    'Usage: ai-personal memory list [--limit n] [--json]',
    '       ai-personal memory search <query> [--json]',
    '       ai-personal memory add <text>',
    '       ai-personal memory edit <id> <text>',
    '       ai-personal memory forget <id>',
].join('\n');

/** ai-personal memory:查看、搜索、添加、修改与删除长期记忆(记忆 v1 的 REST,ADR 0007)。 */
export async function memoryCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, { limit: { type: 'string' }, json: { type: 'boolean' } });
    const { client } = connect(ctx, values.server);

    const print = (items: { id: string; status: string; text: string }[]) => {
        if (values.json) {
            ctx.stdout.write(`${JSON.stringify(items)}\n`);
        } else if (items.length === 0) {
            status(ctx, 'No memories');
        } else {
            table(ctx, [['ID', 'STATUS', 'TEXT'], ...items.map((m) => [m.id, m.status, m.text])]);
        }
    };

    if (sub === 'list') {
        const limit = values.limit === undefined ? 50 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError('--limit must be 1-200');
        print((await client.memory.list({ limit })).items);
        return 0;
    }
    if (sub === 'search') {
        const query = positionals.join(' ').trim();
        if (!query) throw new UsageError(USAGE);
        print((await client.memory.search({ query })).items);
        return 0;
    }
    if (sub === 'add') {
        const text = positionals.join(' ').trim();
        if (!text) throw new UsageError(USAGE);
        const result = await client.memory.save({ text });
        if (result.outcome === 'refused') {
            status(ctx, `Refused (${result.reason ?? 'invalid'}): credentials are never stored in memory`);
            return 1;
        }
        if (result.id) ctx.stdout.write(`${result.id}\n`);
        status(ctx, `Memory ${result.outcome}`);
        return 0;
    }
    if (sub === 'edit') {
        const [id, ...words] = positionals;
        const text = words.join(' ').trim();
        if (!id || !text) throw new UsageError(USAGE);
        await client.memory.update(id, { text });
        status(ctx, `Updated ${id}`);
        return 0;
    }
    if (sub === 'forget') {
        const id = positionals[0];
        if (!id) throw new UsageError(USAGE);
        await client.memory.delete(id);
        status(ctx, `Forgot ${id}`);
        return 0;
    }
    throw new UsageError(USAGE);
}

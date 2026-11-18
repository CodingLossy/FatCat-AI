// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Agent } from '@fatcat-ai/shared';
import { connect, parse, table } from '../common.js';
import { type Ctx, status, UsageError } from '../io.js';

const USAGE = ['Usage: fatcat-ai agents list [--json]', '       fatcat-ai agents show <id|name> [--json]'].join('\n');

export function agentRows(items: Agent[]): string[][] {
    return [
        ['ID', 'NAME', 'KIND', 'MEMORY', 'TOOLS'],
        ...items.map((a) => [
            a.id,
            a.name,
            a.builtin ? `built-in (${a.role})` : 'custom',
            a.memoryScope,
            a.toolSet.includes('delegate') ? `${a.toolSet.length} (can delegate)` : String(a.toolSet.length),
        ]),
    ];
}

export function describeAgent(agent: Agent): string[] {
    return [
        `${agent.name}  (${agent.builtin ? `built-in ${agent.role}` : 'custom'})`,
        `id          ${agent.id}`,
        `tools       ${agent.toolSet.join(', ')}`,
        `memory      ${agent.memoryScope}`,
        `limits      depth ${agent.maxDepth}, steps ${agent.maxSteps}, tokens ${agent.budgetTokens ?? 'none'}, seconds ${agent.budgetSeconds ?? 'none'}`,
        `model       ${agent.modelProfileId ?? 'default'}`,
        'prompt',
        ...agent.systemPrompt.split('\n').map((line) => `  ${line}`),
    ];
}

export async function agentsCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, { json: { type: 'boolean' } });
    const { client } = connect(ctx, values.server);

    if (sub === 'list') {
        const { items } = await client.agents.list();
        if (values.json) ctx.stdout.write(`${JSON.stringify(items)}\n`);
        else if (items.length === 0) status(ctx, 'No agents yet');
        else table(ctx, agentRows(items));
        return 0;
    }

    if (sub === 'show') {
        const ref = positionals[0];
        if (!ref) throw new UsageError(USAGE);
        const { items } = await client.agents.list();
        const agent = items.find((a) => a.id === ref) ?? items.find((a) => a.name === ref);
        if (!agent) throw new UsageError(`Unknown agent: ${ref} (see "fatcat-ai agents list")`);
        if (values.json) ctx.stdout.write(`${JSON.stringify(agent)}\n`);
        else ctx.stdout.write(`${describeAgent(agent).join('\n')}\n`);
        return 0;
    }

    throw new UsageError(USAGE);
}

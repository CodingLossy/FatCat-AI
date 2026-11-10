// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { type AipClient, createClient } from '@ai-personal/client';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { type Ctx, UsageError } from './io.js';

type Options = NonNullable<ParseArgsConfig['options']>;

const GLOBAL_OPTIONS = {
    server: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
} as const satisfies Options;

/** 解析子命令参数;--server 与 --help 对所有子命令都可用。 */
export function parse<O extends Options>(args: string[], options: O) {
    try {
        return parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
    } catch (error) {
        throw new UsageError((error as Error).message);
    }
}

export interface Connection {
    client: AipClient;
    config: ResolvedConfig;
}

/** 按配置优先级建客户端;requireToken 时没有令牌直接报错,不发请求。 */
export function connect(ctx: Ctx, server: string | undefined, requireToken = true): Connection {
    const config = resolveConfig(ctx.env, { server });
    if (requireToken && !config.token) {
        throw new UsageError(`Not signed in to ${config.server}. Run "ai-personal login" or set AIP_TOKEN.`);
    }
    const client = createClient({ baseUrl: config.server, token: requireToken ? config.token : undefined });
    return { client, config };
}

/** 按 id 或 label 找模型配置档。 */
export async function resolveModelId(client: AipClient, ref: string | undefined): Promise<string | undefined> {
    if (!ref) return undefined;
    const { items } = await client.models.list();
    const match = items.find((m) => m.id === ref) ?? items.find((m) => m.label === ref);
    if (!match) throw new UsageError(`Unknown model profile: ${ref} (see "ai-personal models list")`);
    return match.id;
}

/** 简单的定宽表格,写到 stdout。 */
export function table(ctx: Ctx, rows: string[][]): void {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
    for (const row of rows) {
        ctx.stdout.write(
            `${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')}\n`,
        );
    }
}

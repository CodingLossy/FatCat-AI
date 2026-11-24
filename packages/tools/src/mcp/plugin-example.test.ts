// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 示例插件(examples/plugins/hello)必须能被 ADR 0013 的客户端当作普通 MCP 服务器连接并调用(ADR 0040 PR 1 验收)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { StdioMcpClient } from './client.js';

const dir = fileURLToPath(new URL('../../../../examples/plugins/hello/', import.meta.url));

describe('example plugin "hello"', () => {
    it('has a valid manifest whose tools match what the server lists', async () => {
        const result = parsePluginManifest(readFileSync(`${dir}plugin.json`));
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.manifest.entry).toBeDefined();

        const client = new StdioMcpClient(
            { command: process.execPath, args: [`${dir}${result.manifest.entry?.main}`], cwd: dir, envPassthrough: [] },
            { timeoutMs: 15_000 },
        );
        try {
            await client.connect();
            const tools = await client.listTools();
            expect(tools.map((tool) => tool.name).sort()).toEqual(
                result.manifest.permissions.tools.map((t) => t.name).sort(),
            );
            const reply = await client.callTool('hello', { name: 'FatCat' });
            expect(reply.content?.[0]?.text).toBe('Hello, FatCat!');
            expect((await client.callTool('hello', {})).isError).toBe(true);
        } finally {
            client.close();
        }
    }, 30_000);

    it('reads settings from FATCAT_PLUGIN_SETTINGS and serves its knowledge-map notes', async () => {
        const client = new StdioMcpClient(
            {
                command: process.execPath,
                args: [`${dir}server.mjs`],
                cwd: dir,
                envPassthrough: [],
                rawEnv: {
                    PATH: process.env.PATH ?? '',
                    FATCAT_PLUGIN_SETTINGS: JSON.stringify({ greeting: 'Hi', shout: true }),
                },
            },
            { timeoutMs: 15_000 },
        );
        try {
            await client.connect();
            expect((await client.callTool('hello', { name: 'cat' })).content?.[0]?.text).toBe('HI, CAT!');
            const roots = (await client.request('fatcat/items.roots', { type: 'note' })) as {
                items: { id: string; title: string }[];
            };
            expect(roots.items.map((n) => n.id)).toEqual(['welcome', 'tips']);
            const opened = (await client.request('fatcat/items.open', { type: 'note', id: 'tips' })) as {
                content: string;
            };
            expect(opened.content).toContain('knowledge map');
        } finally {
            client.close();
        }
    }, 30_000);
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type Plugin } from './index.js';

interface Reply {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: { code?: string } };
}

/** 把插件接到内存管道上,扮演宿主。 */
function harness(setup: (plugin: Plugin) => void, env: NodeJS.ProcessEnv = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Reply[] = [];
    const waiting: (() => void)[] = [];
    let buffer = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            lines.push(JSON.parse(buffer.slice(0, newline)) as Reply);
            buffer = buffer.slice(newline + 1);
            waiting.splice(0).forEach((resolve) => resolve());
        }
    });
    const plugin = definePlugin({ name: 'test', version: '1.0.0' });
    setup(plugin);
    const done = plugin.run({ input, output, env, heartbeatMs: 60_000, rss: () => 12345 });
    const send = (message: object): void => void input.write(`${JSON.stringify(message)}\n`);
    const next = async (match: (line: Reply) => boolean): Promise<Reply> => {
        for (;;) {
            const index = lines.findIndex(match);
            if (index >= 0) return lines.splice(index, 1)[0]!;
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
    };
    const call = async (id: number, method: string, params?: unknown): Promise<Reply> => {
        send({ jsonrpc: '2.0', id, method, params });
        return next((line) => line.id === id && line.method === undefined);
    };
    return { input, send, next, call, done };
}

let open: ReturnType<typeof harness> | undefined;
afterEach(async () => {
    open?.input.end();
    await open?.done;
    open = undefined;
});

describe('plugin SDK', () => {
    it('answers initialize, lists tools and calls them like a plain MCP server', async () => {
        open = harness((plugin) => {
            plugin.registerTool({
                name: 'echo',
                description: 'Echo',
                handler: (args) => `echo:${String(args.text)}`,
            });
        });
        const init = await open.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
        expect(init.result).toMatchObject({
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'test', version: '1.0.0' },
            capabilities: { tools: {} },
        });
        // 初始化后自动发心跳
        expect(await open.next((line) => line.method === 'fatcat/heartbeat')).toMatchObject({ params: { rss: 12345 } });

        const list = await open.call(2, 'tools/list');
        expect(list.result?.tools).toEqual([
            { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } },
        ]);
        const called = await open.call(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } });
        expect(called.result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] });
    });

    it('turns a failing handler into an isError result without a stack, and rejects unknown tools', async () => {
        open = harness((plugin) => {
            plugin.registerTool({
                name: 'boom',
                description: 'Fails',
                handler: () => {
                    throw new Error('nope');
                },
            });
        });
        const failed = await open.call(1, 'tools/call', { name: 'boom' });
        expect(failed.result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
        const unknown = await open.call(2, 'tools/call', { name: 'missing' });
        expect(unknown.error?.code).toBe(-32602);
    });

    it('answers unknown methods with "method not found", including sampling', async () => {
        open = harness(() => undefined);
        expect((await open.call(1, 'sampling/createMessage', {})).error?.code).toBe(-32601);
        expect((await open.call(2, 'fatcat/secrets.get', {})).error?.data?.code).toBe('method_not_found');
    });

    it('rejects invalid tool names and duplicates at registration', () => {
        const plugin = definePlugin({ name: 'x', version: '1.0.0' });
        const tool = { name: 'ok', description: 'd', handler: () => 'x' };
        expect(() => plugin.registerTool({ ...tool, name: 'Bad Name' })).toThrow(/invalid tool name/);
        plugin.registerTool(tool);
        expect(() => plugin.registerTool(tool)).toThrow(/already registered/);
    });

    it('routes fatcat/net.fetch through the host and decodes the reply', async () => {
        open = harness((plugin) => {
            plugin.registerTool({
                name: 'get',
                description: 'Fetch',
                handler: async (_args, ctx) => {
                    const response = await ctx.fetch('https://api.example.org/data', { headers: { Accept: 'x' } });
                    return `${response.status}:${(response.json() as { value: number }).value}`;
                },
            });
        });
        open.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get' } });
        const request = await open.next((line) => line.method === 'fatcat/net.fetch');
        expect(request.params).toEqual({ url: 'https://api.example.org/data', headers: { Accept: 'x' } });
        open.send({
            jsonrpc: '2.0',
            id: request.id,
            result: { status: 200, headers: {}, body: '{"value":7}', bodyEncoding: 'utf8', truncated: false },
        });
        const reply = await open.next((line) => line.id === 1 && line.method === undefined);
        expect(reply.result).toEqual({ content: [{ type: 'text', text: '200:7' }] });
    });

    it('surfaces permission_denied from the host as an error the tool can catch', async () => {
        open = harness((plugin) => {
            plugin.registerTool({
                name: 'get',
                description: 'Fetch',
                handler: async (_args, ctx) => {
                    try {
                        await ctx.fetch('https://blocked.example/');
                        return 'allowed';
                    } catch (error) {
                        return `${(error as { code?: string }).code}`;
                    }
                },
            });
        });
        open.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get' } });
        const request = await open.next((line) => line.method === 'fatcat/net.fetch');
        open.send({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32001, message: 'denied', data: { code: 'permission_denied' } },
        });
        const reply = await open.next((line) => line.id === 1 && line.method === undefined);
        expect(reply.result).toEqual({ content: [{ type: 'text', text: 'permission_denied' }] });
    });

    it('serves item providers and validates what they return', async () => {
        open = harness((plugin) => {
            plugin.registerItemProvider({
                type: 'video',
                roots: () => [{ id: 'a', type: 'video', title: 'A', hasChildren: true }],
                children: (parentId) => ({
                    items: [{ id: `${parentId}-1`, type: 'video', title: 'Child', hasChildren: false }],
                }),
                open: (id) => ({ title: id, content: 'body' }),
            });
        });
        expect((await open.call(1, 'fatcat/items.roots', {})).result?.items).toHaveLength(1);
        expect((await open.call(2, 'fatcat/items.children', { type: 'video', parentId: 'a' })).result?.items).toEqual([
            { id: 'a-1', type: 'video', title: 'Child', hasChildren: false },
        ]);
        expect((await open.call(3, 'fatcat/items.open', { type: 'video', id: 'a' })).result).toEqual({
            title: 'a',
            content: 'body',
        });
        expect((await open.call(4, 'fatcat/items.open', { type: 'music', id: 'a' })).error?.code).toBe(-32602);
        expect((await open.call(5, 'fatcat/items.children', { parentId: 'a' })).error?.code).toBe(-32602);
    });

    it('reads secrets from the environment only', async () => {
        let seen: (string | undefined)[] = [];
        open = harness(
            (plugin) => {
                plugin.registerTool({
                    name: 'peek',
                    description: 'Peek',
                    handler: (_args, ctx) => {
                        seen = [ctx.secret('WEATHER_API_KEY'), ctx.secret('MISSING'), ctx.dataDir];
                        return 'ok';
                    },
                });
            },
            { WEATHER_API_KEY: 'k', FATCAT_PLUGIN_DATA: '/data' },
        );
        await open.call(1, 'tools/call', { name: 'peek' });
        expect(seen).toEqual(['k', undefined, '/data']);
    });

    it('never reads FATCAT_AI_* variables and honours the declared secret names', async () => {
        const seen: (string | undefined)[] = [];
        open = harness(
            (plugin) => {
                plugin.registerTool({
                    name: 'peek',
                    description: 'Peek',
                    handler: (_args, ctx) => {
                        seen.push(ctx.secret('FATCAT_AI_TOKEN'), ctx.secret('AIP_TOKEN'), ctx.secret('OTHER'));
                        return 'ok';
                    },
                });
            },
            { FATCAT_AI_TOKEN: 't', AIP_TOKEN: 't', OTHER: 'o' },
        );
        await open.call(1, 'tools/call', { name: 'peek' });
        expect(seen).toEqual([undefined, undefined, 'o']);

        const restricted = definePlugin({ name: 'x', version: '1.0.0', secrets: ['ALLOWED'] });
        let got: (string | undefined)[] = [];
        restricted.registerTool({
            name: 'peek',
            description: 'Peek',
            handler: (_args, ctx) => {
                got = [ctx.secret('ALLOWED'), ctx.secret('OTHER')];
                return 'ok';
            },
        });
        const input = new PassThrough();
        const output = new PassThrough();
        const done = restricted.run({ input, output, env: { ALLOWED: 'a', OTHER: 'o' } });
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'peek' } })}\n`);
        await new Promise((resolve) => output.once('data', resolve));
        input.end();
        await done;
        expect(got).toEqual(['a', undefined]);
    });
});

describe('heartbeat', () => {
    it('repeats on the interval and stops after the host closes stdin', async () => {
        vi.useFakeTimers();
        try {
            const input = new PassThrough();
            const output = new PassThrough();
            let data = '';
            output.on('data', (chunk: Buffer) => (data += chunk.toString()));
            const beats = (): number => data.split('\n').filter((l) => l.includes('fatcat/heartbeat')).length;
            const plugin = definePlugin({ name: 'x', version: '1.0.0' });
            const done = plugin.run({ input, output, env: {}, heartbeatMs: 30_000, rss: () => 1 });
            input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
            await vi.advanceTimersByTimeAsync(0);
            expect(beats()).toBe(1);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(beats()).toBe(2);
            input.end();
            await done;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(beats()).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

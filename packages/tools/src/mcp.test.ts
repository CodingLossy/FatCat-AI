// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, type ToolContext } from './index.js';
import { childEnv, McpManager, type OwnedMcpServer, resultText, StdioMcpClient, toolSegment } from './mcp/index.js';

const FAKE = fileURLToPath(new URL('../test/fake-mcp-server.mjs', import.meta.url));
const ctx: ToolContext = {
    ownerId: 'o',
    sessionId: 's',
    runId: 'r',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

const server = (over: Partial<OwnedMcpServer> = {}): OwnedMcpServer => ({
    ownerId: 'o',
    id: '01JC0000000000000000000000',
    name: 'fake',
    command: process.execPath,
    args: [FAKE],
    cwd: null,
    envPassthrough: [],
    enabled: true,
    toolRisks: {},
    createdAt: '2026-11-04T00:00:00.000Z',
    ...over,
});

let manager: McpManager | null = null;
afterEach(() => manager?.closeAll());

describe('StdioMcpClient(假服务器)', () => {
    it('握手、翻页列出工具、调用;忽略通知与非 JSON 行,并回答服务器发来的请求', async () => {
        const client = new StdioMcpClient({ command: process.execPath, args: [FAKE], envPassthrough: [] });
        await client.connect();
        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['echo', 'fail', 'bad name!', 'env']);
        expect(await client.callTool('echo', { text: '你好' })).toMatchObject({
            content: [{ type: 'text', text: 'echo: 你好' }, { type: 'image' }],
        });
        await expect(client.callTool('missing', {})).rejects.toThrow(/unknown tool missing/);
        expect(client.stderrTail).toContain('fake server starting');
        client.close();
        await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/not connected/);
    });

    it('启动失败、进程在握手时退出、请求超时都报错', async () => {
        await expect(
            new StdioMcpClient({
                command: 'definitely-not-a-real-command-xyz',
                args: [],
                envPassthrough: [],
            }).connect(),
        ).rejects.toThrow(/could not start|exited/);
        await expect(
            new StdioMcpClient({
                command: process.execPath,
                args: [FAKE, 'exit-on-init'],
                envPassthrough: [],
            }).connect(),
        ).rejects.toThrow(/exited \(code 3\)/);
        const slow = new StdioMcpClient(
            { command: process.execPath, args: [FAKE, 'no-reply'], envPassthrough: [] },
            { timeoutMs: 200 },
        );
        await expect(slow.connect()).rejects.toThrow(/initialize timed out/);
        slow.close();
    });

    it('子进程只拿到最小环境与允许传递的变量', () => {
        const env = {
            PATH: '/bin',
            MCP_TEST_ALLOWED: 'yes',
            MCP_TEST_SECRET: 'no',
            HOME: '/home/u',
            FATCAT_AI_KEY: 'k',
            AIP_KEY: 'old',
        };
        // FATCAT_AI_* 与旧名 AIP_* 即使被列出也不传(大小写不敏感)
        expect(childEnv(['MCP_TEST_ALLOWED', 'FATCAT_AI_KEY', 'fatcat_ai_key', 'AIP_KEY', 'aip_key'], env)).toEqual({
            PATH: '/bin',
            HOME: '/home/u',
            MCP_TEST_ALLOWED: 'yes',
        });
    });
});

describe('McpManager', () => {
    it('以 mcp.<server>.<tool> 注册工具,默认 write,可按工具覆盖;输出与错误都标为不可信;核对 owner;不允许传递的变量看不到', async () => {
        const registry = new ToolRegistry();
        manager = new McpManager({
            registry,
            env: { ...process.env, MCP_TEST_ALLOWED: 'yes', MCP_TEST_SECRET: 'top-secret' },
        });
        const status = await manager.apply(
            server({ toolRisks: { echo: 'read' }, envPassthrough: ['MCP_TEST_ALLOWED'] }),
        );
        expect(status).toEqual({
            state: 'connected',
            tools: ['mcp.fake.echo', 'mcp.fake.fail', 'mcp.fake.bad_name_', 'mcp.fake.env'],
            error: null,
        });
        expect(registry.info().map((t) => [t.name, t.risk, t.approval, t.source, t.server])).toEqual([
            ['mcp.fake.bad_name_', 'write', 'required', 'mcp', 'fake'],
            ['mcp.fake.echo', 'read', 'auto', 'mcp', 'fake'],
            ['mcp.fake.env', 'write', 'required', 'mcp', 'fake'],
            ['mcp.fake.fail', 'write', 'required', 'mcp', 'fake'],
        ]);
        const echo = registry.get('mcp.fake.echo')!;
        expect(echo.untrustedOutput).toBe(true);
        expect(echo.parameters).toMatchObject({ required: ['text'] });
        expect(await echo.execute({ text: 'hi' }, ctx)).toEqual({
            untrusted: true,
            source: { kind: 'mcp', ref: 'mcp.fake.echo' },
            content: 'echo: hi\n[image content omitted]',
            truncated: false,
        });
        // 错误文本同样是不可信内容,不作为异常抛出
        expect(await registry.get('mcp.fake.fail')!.execute({}, ctx)).toMatchObject({
            untrusted: true,
            content: '[The MCP tool reported an error]\nit broke',
        });
        // 越权:别的 owner 的运行不能调用这个服务器的工具
        await expect(echo.execute({ text: 'hi' }, { ...ctx, ownerId: 'other' })).rejects.toThrow(/another account/);
        const env = (await registry.get('mcp.fake.env')!.execute({}, ctx)) as { content: string };
        expect(JSON.parse(env.content)).toEqual({ allowed: 'yes', secret: null });
        expect(echo.summarize({ text: 'x' })).toBe('fake: echo {"text":"x"}');

        // 禁用:整组工具移除;删除:状态回到 disconnected
        expect(await manager.apply(server({ enabled: false }))).toMatchObject({ state: 'disabled', tools: [] });
        expect(registry.size).toBe(0);
        manager.remove(server().id);
        expect(manager.status(server().id)).toMatchObject({ state: 'disconnected' });
    });

    it('连接失败时状态为 error,不注册工具;进程退出后工具被移除', async () => {
        const registry = new ToolRegistry();
        manager = new McpManager({ registry });
        expect(await manager.apply(server({ args: [FAKE, 'exit-on-init'] }))).toMatchObject({
            state: 'error',
            error: expect.stringMatching(/exited/) as string,
        });
        expect(registry.size).toBe(0);
    });

    it('工具名与结果文本的转换', () => {
        expect(toolSegment('read_file')).toBe('read_file');
        expect(toolSegment('a.b c')).toBe('a_b_c');
        expect(toolSegment('x'.repeat(65))).toBeNull();
        expect(resultText({})).toBe('');
        expect(resultText({ content: [{ type: 'resource' }] })).toBe('[resource content omitted]');
        expect(resultText({ structuredContent: { a: 1 } })).toBe('{"a":1}');
    });
});

// 官方示例服务器(devDependency,不需要网络;它要求 Node ≥ 24)
const officialServer = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
describe.runIf(Number(process.versions.node.split('.')[0]) >= 24)(
    '官方 @modelcontextprotocol/server-filesystem',
    () => {
        it('列出工具并读取授权目录中的文件', async () => {
            const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-mcp-official-')));
            writeFileSync(path.join(dir, 'hello.txt'), 'hello from MCP');
            try {
                const registry = new ToolRegistry();
                manager = new McpManager({ registry });
                const status = await manager.apply(
                    server({ name: 'files', command: process.execPath, args: [officialServer, dir] }),
                );
                expect(status.state, status.error ?? '').toBe('connected');
                expect(status.tools).toContain('mcp.files.read_text_file');
                expect(registry.get('mcp.files.read_text_file')!.risk).toBe('write');
                const out = await registry
                    .get('mcp.files.read_text_file')!
                    .execute({ path: path.join(dir, 'hello.txt') }, ctx);
                expect(out).toMatchObject({ untrusted: true, content: 'hello from MCP' });
            } finally {
                manager?.closeAll();
                rmSync(dir, { recursive: true, force: true });
            }
        }, 60_000);
    },
);

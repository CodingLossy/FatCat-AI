// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 操作系统层的网络隔离必须独立于预加载生效:去掉预加载后,插件仍然连不上本机端口。
// 当前平台不支持(Windows、禁止非特权 user namespace 的 Linux)时跳过。
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../mcp/client.js';
import { detectNetIsolation, NO_NET_ISOLATION, type NetIsolation } from './isolation.js';
import { pluginEnv, pluginNodeArgs } from './launch.js';

const fixture = fileURLToPath(new URL('./fixtures/probe-plugin.js', import.meta.url));
const isolation = await detectNetIsolation();

async function attackWithoutPreload(wrapper: NetIsolation, port: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'fatcat-iso-'));
    const codeDir = join(root, 'code');
    const dataDir = join(root, 'data');
    mkdirSync(codeDir, { recursive: true });
    mkdirSync(join(dataDir, 'home'), { recursive: true });
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    cpSync(fixture, join(codeDir, 'probe-plugin.js'));
    const launch = wrapper.wrap(
        process.execPath,
        pluginNodeArgs({ codeDir, dataDir, main: 'probe-plugin.js', preload: null }),
    );
    const client = new StdioMcpClient(
        {
            command: launch.command,
            args: launch.args,
            cwd: dataDir,
            envPassthrough: [],
            rawEnv: pluginEnv({ pluginId: 'probe', dataDir, secrets: {}, source: { PATH: process.env.PATH ?? '' } }),
        },
        { timeoutMs: 15_000 },
    );
    try {
        await client.connect();
        const reply = await client.callTool('probe', { attack: 'stdin-socket', arg: port });
        return String(reply.content?.[0]?.text ?? '');
    } finally {
        await client.shutdown(1000, 500);
        rmSync(root, { recursive: true, force: true });
    }
}

describe.skipIf(isolation.kind === 'none')(`OS network isolation (${isolation.kind})`, () => {
    let server: ReturnType<typeof createServer>;
    let port = '';
    beforeAll(async () => {
        server = createServer((socket) => socket.end('SERVER-SECRET'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = String((server.address() as { port: number }).port);
    });
    afterAll(() => server.close());

    it('control: without the preload and without the OS layer, the stdin socket reaches the local server', async () => {
        expect(await attackWithoutPreload(NO_NET_ISOLATION, port)).toContain('SERVER-SECRET');
    }, 30_000);

    it('with only the OS layer (no preload), the same attack cannot connect', async () => {
        const result = await attackWithoutPreload(isolation, port);
        expect(result).toMatch(/^blocked/);
        expect(result).not.toContain('SERVER-SECRET');
    }, 30_000);

    // 已知例外:路径形式的 Unix socket 走文件系统,空的网络命名空间挡不住,只靠预加载拦截。
    // 这条把例外固定下来;以后在操作系统层也挡住了,这里会失败,再把说明改成 enforced。
    it.skipIf(isolation.kind !== 'unshare')(
        'known gap: with only the OS layer, a Unix socket file outside the plugin dirs is still reachable',
        async () => {
            const dir = mkdtempSync(join(tmpdir(), 'fatcat-sock-'));
            const path = join(dir, 's.sock');
            const unix = createServer((socket) => socket.end('UNIX-SECRET'));
            await new Promise<void>((resolve) => unix.listen(path, resolve));
            try {
                expect(await attackWithoutPreload(isolation, path)).toContain('UNIX-SECRET');
            } finally {
                unix.close();
                rmSync(dir, { recursive: true, force: true });
            }
        },
        30_000,
    );
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件运行时的越权用例与生命周期(ADR 0040 第 11 节 PR 2b 验收)。用的是一个真实的 node 子进程,不是替身。
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { hashPluginDir } from './package.js';
import { PluginRuntime, type PluginEventInput, type PluginRuntimeRecord, redactSecrets } from './runtime.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SECRET = 'sk-test-9f3a-very-secret';

interface Harness {
    root: string;
    codeRoot: string;
    dataRoot: string;
    registry: ToolRegistry;
    events: PluginEventInput[];
    states: { pluginId: string; state: string; error: string }[];
    runtime: PluginRuntime;
    record: PluginRuntimeRecord;
}

function setup(manifestPatch: (m: Record<string, unknown>) => void = () => undefined): Harness {
    const root = mkdtempSync(join(tmpdir(), 'fatcat-plugin-'));
    const codeRoot = join(root, 'plugins');
    const dataRoot = join(root, 'plugin-data');
    const codeDir = join(codeRoot, 'probe', '0.1.0');
    cpSync(fixtures, codeDir, { recursive: true, filter: (src) => !src.endsWith('.test.ts') });
    const manifestRaw = JSON.parse(readFileSync(join(codeDir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    manifestPatch(manifestRaw);
    writeFileSync(join(codeDir, 'plugin.json'), JSON.stringify(manifestRaw));
    const parsed = validatePluginManifest(manifestRaw);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    // 主程序自己的敏感文件:在插件目录之外
    writeFileSync(join(root, 'master.key'), 'MASTER');
    writeFileSync(join(root, 'secrets.yaml.enc'), 'ENC');
    writeFileSync(join(root, 'db.sqlite'), 'DB');
    mkdirSync(join(dataRoot, 'other'), { recursive: true });
    writeFileSync(join(dataRoot, 'other', 'data.txt'), 'other plugin data');
    const registry = new ToolRegistry();
    const events: PluginEventInput[] = [];
    const states: Harness['states'] = [];
    const runtime = new PluginRuntime({
        registry,
        codeRoot,
        dataRoot,
        env: {
            PATH: process.env.PATH ?? '',
            FATCAT_AI_SECRET: 'must-not-leak',
            AIP_OLD: 'x',
            NODE_OPTIONS: '--no-warnings',
            MY_KEY: SECRET,
        },
        idleMs: 400,
        graceMs: 1000,
        termMs: 500,
        handshakeTimeoutMs: 15_000,
        onEvent: (_o, e) => events.push(e),
        onState: (_o, pluginId, state, error) => states.push({ pluginId, state, error }),
    });
    const record: PluginRuntimeRecord = {
        ownerId: 'owner1',
        pluginId: 'probe',
        version: '0.1.0',
        manifest: parsed.manifest,
        granted: parsed.manifest.permissions,
        contentSha256: hashPluginDir(codeDir),
        secretRefs: { WEATHER_API_KEY: 'env:MY_KEY' },
        settings: {},
    };
    return { root, codeRoot, dataRoot, registry, events, states, runtime, record };
}

const ctx = (ownerId = 'owner1') => ({ ownerId }) as never;

async function run(h: Harness, tool: string, input: unknown, ownerId = 'owner1'): Promise<string> {
    const def = h.registry.get(`plugin.probe.${tool}`);
    if (!def) throw new Error(`tool ${tool} is not registered`);
    const out = (await def.execute(input, ctx(ownerId))) as { content: string };
    return out.content;
}

describe('plugin runtime', () => {
    let h: Harness;
    beforeEach(() => {
        h = setup();
    });
    afterEach(async () => {
        await h.runtime.closeAll();
        rmSync(h.root, { recursive: true, force: true });
    });

    it('registers only declared tools, wraps output as untrusted plugin content and applies the risk floor', async () => {
        const status = await h.runtime.apply(h.record);
        expect(status.state).toBe('running');
        expect(status.tools.sort()).toEqual(['plugin.probe.echo', 'plugin.probe.probe']);
        expect(h.registry.get('plugin.probe.undeclared')).toBeUndefined();
        const def = h.registry.get('plugin.probe.echo')!;
        expect(def.source).toBe('plugin');
        const out = (await def.execute({ text: 'hi' }, ctx())) as {
            untrusted: boolean;
            source: { kind: string };
            content: string;
        };
        expect(out).toMatchObject({ untrusted: true, source: { kind: 'plugin' }, content: 'hi' });
        await expect(def.execute({ text: 'hi' }, ctx('someone-else'))).rejects.toThrow(/another account/);
    }, 30_000);

    it('blocks reads of host secrets, other plugins data and writes outside its data dir', async () => {
        await h.runtime.apply(h.record);
        const attempts: [string, string][] = [
            ['read', join(h.root, 'master.key')],
            ['read', join(h.root, 'secrets.yaml.enc')],
            ['read', join(h.root, 'db.sqlite')],
            ['read', join(h.dataRoot, 'other', 'data.txt')],
            ['list', h.dataRoot],
            ['write', join(h.root, 'pwned.txt')],
            ['write', join(h.codeRoot, 'probe', '0.1.0', 'probe-plugin.js')],
        ];
        for (const [attack, arg] of attempts) {
            const result = await run(h, 'probe', { attack, arg });
            expect(result, `${attack} ${arg}`).toMatch(/^blocked/);
        }
        // 自己的数据目录可读写
        expect(await run(h, 'probe', { attack: 'write', arg: join(h.dataRoot, 'probe', 'ok.txt') })).toMatch(
            /^ALLOWED/,
        );
    }, 60_000);

    it('blocks every denied built-in module via import, bare import, require/createRequire, getBuiltinModule, Module._load and data URLs', async () => {
        await h.runtime.apply(h.record);
        const table = JSON.parse(await run(h, 'probe', { attack: 'builtins' })) as Record<string, string>;
        const allowed = Object.entries(table).filter(([, v]) => v !== 'blocked');
        expect(allowed).toEqual([]);
        expect(Object.keys(table)).toHaveLength(18 * 7);
        for (const attack of ['binding', 'dlopen', 'fetch']) {
            expect(await run(h, 'probe', { attack })).toMatch(/^blocked/);
        }
    }, 60_000);

    it('cannot re-register module hooks to reach node:http, and cannot signal the parent or create links', async () => {
        await h.runtime.apply(h.record);
        const server = createServer((_req, res) => res.end('SERVER-SECRET'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
            const bypass = await run(h, 'probe', { attack: 'hookbypass', arg: String(port) });
            expect(bypass).toMatch(/^blocked/);
            expect(bypass).not.toContain('SERVER-SECRET');
        } finally {
            server.close();
        }
        expect(await run(h, 'probe', { attack: 'register' })).toMatch(/^blocked/);
        expect(await run(h, 'probe', { attack: 'kill2' })).toMatch(/^blocked/);
        expect(await run(h, 'probe', { attack: 'kill-parent' })).toMatch(/^blocked/);
        const target = join(h.root, 'master.key');
        expect(await run(h, 'probe', { attack: 'symlink', arg: target })).toMatch(/^blocked/);
        expect(await run(h, 'probe', { attack: 'hardlink', arg: target })).toMatch(/^blocked/);
    }, 60_000);

    it('cannot reach node:http by rewriting Module._resolveFilename or Module._load', async () => {
        await h.runtime.apply(h.record);
        const server = createServer((_req, res) => res.end('SERVER-SECRET'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = String((server.address() as { port: number }).port);
        try {
            for (const attack of ['resolvepatch', 'loadpatch']) {
                const result = await run(h, 'probe', { attack, arg: port });
                expect(result, attack).toMatch(/^blocked/);
                expect(result).not.toContain('SERVER-SECRET');
            }
        } finally {
            server.close();
        }
    }, 60_000);

    it('cannot connect through the stdio sockets that already exist, over TCP or a Unix socket, and JSON-RPC still works', async () => {
        await h.runtime.apply(h.record);
        const tcp = createNetServer((socket) => socket.end('SERVER-SECRET'));
        await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
        const port = String((tcp.address() as { port: number }).port);
        // Windows 上没有 Unix socket 文件,用命名管道
        const socketPath =
            process.platform === 'win32'
                ? `\\\\.\\pipe\\fatcat-test-${process.pid}-${Date.now()}`
                : join(h.root, 'local.sock');
        const unix = createNetServer((socket) => socket.end('SERVER-SECRET'));
        await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
        try {
            for (const [attack, arg] of [
                ['stdin-socket', port],
                ['stdout-socket', port],
                ['stdin-socket', socketPath],
                ['stdout-socket', socketPath],
                ['pipe-handle', socketPath],
            ] as const) {
                const result = await run(h, 'probe', { attack, arg });
                expect(result, `${attack} ${arg}`).toContain('ERR_ACCESS_DENIED');
                expect(result).not.toContain('SERVER-SECRET');
            }
            // 正向对照:标准流上的 JSON-RPC 照常工作
            expect(await run(h, 'echo', { text: 'still works' })).toBe('still works');
        } finally {
            tcp.close();
            unix.close();
        }
    }, 60_000);

    it('starts with a minimal environment and no FATCAT_AI_* / AIP_* / NODE_OPTIONS', async () => {
        await h.runtime.apply(h.record);
        const keys = JSON.parse(await run(h, 'probe', { attack: 'env' })) as string[];
        expect(keys).toEqual(
            expect.arrayContaining(['FATCAT_PLUGIN_ID', 'FATCAT_PLUGIN_DATA', 'HOME', 'TMPDIR', 'WEATHER_API_KEY']),
        );
        for (const key of keys) {
            expect(key).not.toMatch(/^(FATCAT_AI_|AIP_)/);
        }
        expect(keys).not.toContain('NODE_OPTIONS');
        expect(keys).not.toContain('MY_KEY');
    }, 30_000);

    it('answers unauthorized and unknown fatcat/* methods with permission_denied / method not found and records denied', async () => {
        await h.runtime.apply(h.record);
        expect(await run(h, 'probe', { attack: 'rpc', arg: 'fatcat/net.fetch' })).toContain('permission_denied');
        expect(await run(h, 'probe', { attack: 'rpc', arg: 'fatcat/items.upsert' })).toContain('permission_denied');
        expect(await run(h, 'probe', { attack: 'rpc', arg: 'sampling/createMessage' })).toContain('Method not found');
        const denied = h.events.filter((e) => e.kind === 'denied');
        expect(denied.map((e) => e.detail)).toEqual([
            'fatcat/net.fetch: net is not granted',
            'fatcat/items.upsert: items is not granted',
        ]);
    }, 30_000);

    it('never writes the secret value to events or state when the plugin prints it to stderr and crashes', async () => {
        await h.runtime.apply(h.record);
        await run(h, 'probe', { attack: 'secret-stderr' }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
        const dump = JSON.stringify([h.events, h.states]);
        expect(dump).not.toContain(SECRET);
        expect(h.events.some((e) => e.kind === 'crashed')).toBe(true);
    }, 30_000);

    it('disables the plugin after 3 crashes within 5 minutes', async () => {
        await h.runtime.apply(h.record);
        for (let i = 0; i < 3; i++) {
            const status = h.runtime.status('probe');
            if (status.state === 'error') break;
            await run(h, 'probe', { attack: 'secret-stderr' }).catch(() => undefined);
            await new Promise((r) => setTimeout(r, 800));
        }
        expect(h.states.at(-1)).toMatchObject({ pluginId: 'probe', state: 'error' });
        expect(h.runtime.status('probe').state).toBe('error');
        expect(h.registry.get('plugin.probe.echo')).toBeUndefined();
    }, 60_000);

    it('stops when idle and when asked, and restarts on the next call', async () => {
        await h.runtime.apply(h.record);
        await new Promise((r) => setTimeout(r, 1500));
        expect(h.events.filter((e) => e.kind === 'stopped').map((e) => e.detail)).toEqual(['idle']);
        expect(h.runtime.status('probe').state).toBe('idle');
        expect(await run(h, 'echo', { text: 'again' })).toBe('again');
        await h.runtime.stop('probe');
        expect(h.events.at(-1)).toMatchObject({ kind: 'stopped', detail: 'manual' });
        expect(await run(h, 'echo', { text: 'third' })).toBe('third');
    }, 30_000);

    it('refuses to start when the code directory was modified or the data dir holds a symlink', async () => {
        writeFileSync(join(h.codeRoot, 'probe', '0.1.0', 'extra.js'), '//');
        const status = await h.runtime.apply(h.record);
        expect(status.state).toBe('error');
        expect(status.error).toMatch(/modified/);
        expect(h.events.some((e) => e.kind === 'checksum-mismatch')).toBe(true);

        const h2 = setup();
        try {
            mkdirSync(join(h2.dataRoot, 'probe'), { recursive: true });
            symlinkSync(join(h2.root, 'master.key'), join(h2.dataRoot, 'probe', 'link'));
            const status2 = await h2.runtime.apply(h2.record);
            expect(status2.state).toBe('error');
            expect(status2.error).toMatch(/link/);
        } finally {
            await h2.runtime.closeAll();
            rmSync(h2.root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('risk floor', () => {
    it('raises read to write when the plugin may use the network and makes sendsData external and not pre-authorizable', async () => {
        const h = setup((m) => {
            const permissions = m.permissions as { tools: Record<string, unknown>[]; net?: string[] };
            permissions.net = ['api.example.org'];
            permissions.tools = [
                { name: 'echo', risk: 'read' },
                { name: 'probe', risk: 'read', sendsData: true },
            ];
        });
        try {
            await h.runtime.apply(h.record);
            expect(h.registry.get('plugin.probe.echo')).toMatchObject({ risk: 'write' });
            const probe = h.registry.get('plugin.probe.probe')!;
            expect(probe.risk).toBe('external');
            expect(probe.preauthorizable).toBe(false);
            // net 已授权但 PR 3 才实现代发:拒绝以「不可用」回应,不当作越权
            expect(await run(h, 'probe', { attack: 'rpc', arg: 'fatcat/net.fetch' })).toContain('not available');
        } finally {
            await h.runtime.closeAll();
            rmSync(h.root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('redactSecrets', () => {
    it('also removes the base64, base64url and URL-encoded forms', () => {
        const secret = 'sk-test/9f3a+very=secret';
        const text = [
            secret,
            Buffer.from(secret).toString('base64'),
            Buffer.from(secret).toString('base64url'),
            encodeURIComponent(secret),
        ].join(' | ');
        expect(redactSecrets(text, [secret])).toBe('[redacted] | [redacted] | [redacted] | [redacted]');
    });
});

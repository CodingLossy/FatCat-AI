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
import {
    PluginQuotaError,
    PluginRuntime,
    pluginSettingsValues,
    type PluginEventInput,
    type PluginRuntimeRecord,
    redactSecrets,
} from './runtime.js';

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

/**
 * afterEach 要停掉子进程并删除临时目录。Windows 上释放进程与文件句柄比 Linux 慢得多,
 * vitest 默认的 10 秒钩子超时曾偶发超时,所以单独放宽(测试本身的超时已经逐个设置)。
 */
const HOOK_TIMEOUT_MS = 30_000;

/** 轮询等待条件成立,代替固定的 sleep:慢机器(Windows 上起 node 进程)多等,快机器立刻继续。 */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

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
        rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }, HOOK_TIMEOUT_MS);

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
        await waitUntil(() => h.events.some((e) => e.kind === 'crashed'), 'the crash event');
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
            rmSync(h2.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
            // net 已授权:缺少参数是 invalid params,不是越权
            expect(await run(h, 'probe', { attack: 'rpc', arg: 'fatcat/net.fetch' })).toContain('invalid params');
        } finally {
            await h.runtime.closeAll();
            rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

describe('fatcat/net.fetch', () => {
    let h: Harness;
    beforeEach(() => {
        h = setup((m) => {
            (m.permissions as Record<string, unknown>).net = ['api.example.org', '*.cdn.example.org'];
        });
    });
    afterEach(async () => {
        await h.runtime.closeAll();
        rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }, HOOK_TIMEOUT_MS);

    const fetchVia = (params: Record<string, unknown>) =>
        run(h, 'probe', { attack: 'rpc', arg: 'fatcat/net.fetch', params });
    const denied = () => h.events.filter((e) => e.kind === 'denied').map((e) => e.detail);

    it('refuses domains that were not granted, non-https URLs and forbidden headers, and records denied', async () => {
        await h.runtime.apply(h.record);
        expect(await fetchVia({ url: 'https://other.example.net/' })).toContain('permission_denied');
        expect(await fetchVia({ url: 'http://api.example.org/' })).toContain('invalid params');
        expect(await fetchVia({ url: 'https://api.example.org/', headers: { Cookie: 'x' } })).toContain(
            'invalid params',
        );
        expect(denied()).toEqual(['fatcat/net.fetch: domain is not granted']);
    }, 30_000);

    it('refuses granted domains that resolve to loopback, private or metadata addresses', async () => {
        const resolveTo = (address: string) => async () => [{ address, family: 4 }];
        for (const [address, label] of [
            ['127.0.0.1', 'loopback'],
            ['10.1.2.3', 'private'],
            ['169.254.169.254', 'metadata'],
        ] as const) {
            const local = setup((m) => {
                (m.permissions as Record<string, unknown>).net = ['api.example.org'];
            });
            const runtime = new PluginRuntime({
                registry: local.registry,
                codeRoot: local.codeRoot,
                dataRoot: local.dataRoot,
                env: { PATH: process.env.PATH ?? '' },
                handshakeTimeoutMs: 15_000,
                netFetchOverrides: { resolve: resolveTo(address) },
                onEvent: (_o, e) => local.events.push(e),
                onState: () => undefined,
            });
            try {
                await runtime.apply(local.record);
                const out = await run(local, 'probe', {
                    attack: 'rpc',
                    arg: 'fatcat/net.fetch',
                    params: { url: 'https://api.example.org/' },
                });
                expect(out, label).toContain('permission_denied');
                expect(local.events.filter((e) => e.kind === 'denied').map((e) => e.detail)).toEqual([
                    'fatcat/net.fetch: destination is not allowed',
                ]);
            } finally {
                await runtime.closeAll();
                rmSync(local.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        }
    }, 60_000);

    it('reports a fake-IP resolution as a failed request (a settings matter), not as a denied call', async () => {
        const local = setup((m) => {
            (m.permissions as Record<string, unknown>).net = ['api.example.org'];
        });
        const runtime = new PluginRuntime({
            registry: local.registry,
            codeRoot: local.codeRoot,
            dataRoot: local.dataRoot,
            env: { PATH: process.env.PATH ?? '' },
            handshakeTimeoutMs: 15_000,
            netFetchOverrides: { resolve: async () => [{ address: '198.18.0.7', family: 4 }] },
            onEvent: (_o, e) => local.events.push(e),
            onState: () => undefined,
        });
        try {
            await runtime.apply(local.record);
            const out = await run(local, 'probe', {
                attack: 'rpc',
                arg: 'fatcat/net.fetch',
                params: { url: 'https://api.example.org/' },
            });
            expect(out).toContain('fetch_failed');
            expect(local.events.filter((e) => e.kind === 'denied')).toEqual([]);
        } finally {
            await runtime.closeAll();
            rmSync(local.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }, 30_000);

    it('reports a host that resolves to no address as a failed request (a network matter), not as a denied call', async () => {
        const local = setup((m) => {
            (m.permissions as Record<string, unknown>).net = ['api.example.org'];
        });
        const runtime = new PluginRuntime({
            registry: local.registry,
            codeRoot: local.codeRoot,
            dataRoot: local.dataRoot,
            env: { PATH: process.env.PATH ?? '' },
            handshakeTimeoutMs: 15_000,
            netFetchOverrides: { resolve: async () => [] },
            onEvent: (_o, e) => local.events.push(e),
            onState: () => undefined,
        });
        try {
            await runtime.apply(local.record);
            const out = await run(local, 'probe', {
                attack: 'rpc',
                arg: 'fatcat/net.fetch',
                params: { url: 'https://api.example.org/' },
            });
            expect(out).toContain('fetch_failed');
            expect(local.events.filter((e) => e.kind === 'denied')).toEqual([]);
        } finally {
            await runtime.closeAll();
            rmSync(local.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }, 30_000);
});

describe('fatcat/items.upsert', () => {
    it('writes only inside registered categories, refuses oversized meta and quota overruns, and records denied', async () => {
        const written: { type: string; id: string }[] = [];
        const h = setup((m) => {
            (m.permissions as Record<string, unknown>).items = {
                categories: [{ type: 'video', title: { en: 'Videos' } }],
            };
        });
        const runtime = new PluginRuntime({
            registry: h.registry,
            codeRoot: h.codeRoot,
            dataRoot: h.dataRoot,
            env: { PATH: process.env.PATH ?? '' },
            handshakeTimeoutMs: 15_000,
            onEvent: (_o, e) => h.events.push(e),
            onState: () => undefined,
            upsertItems: (_o, _p, items) => {
                if (items.some((i) => i.id === 'over-quota')) throw new PluginQuotaError('quota');
                written.push(...items.map((i) => ({ type: i.type, id: i.id })));
                return items.length;
            },
        });
        try {
            await runtime.apply(h.record);
            const upsert = (items: unknown[]) =>
                run(h, 'probe', { attack: 'rpc', arg: 'fatcat/items.upsert', params: { items } });
            expect(await upsert([{ id: 'a', type: 'video', title: 'A' }])).toContain('"upserted":1');
            expect(await upsert([{ id: 'b', type: 'other', title: 'B' }])).toContain('permission_denied');
            expect(await upsert([{ id: 'c', type: 'video', title: 'C', meta: { blob: 'x'.repeat(9000) } }])).toContain(
                'quota_exceeded',
            );
            expect(await upsert([{ id: 'over-quota', type: 'video', title: 'Q' }])).toContain('quota_exceeded');
            expect(written).toEqual([{ type: 'video', id: 'a' }]);
            expect(h.events.filter((e) => e.kind === 'denied').map((e) => e.detail)).toEqual([
                'fatcat/items.upsert: item type is not a registered category',
                'fatcat/items.upsert: meta is larger than 8 KiB',
                'fatcat/items.upsert: item quota exceeded',
            ]);
        } finally {
            await runtime.closeAll();
            rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }, 60_000);
});

describe('pluginSettingsValues', () => {
    const manifest = (
        validatePluginManifest({
            manifestVersion: 1,
            id: 'weather',
            version: '1.0.0',
            name: { en: 'Weather' },
            description: { en: 'x' },
            author: 'a',
            license: 'MIT',
            engines: { fatcat: '>=0.0.0' },
            entry: { type: 'mcp-stdio', main: 'server.js' },
            permissions: {},
            settings: {
                type: 'object',
                properties: { city: { type: 'string', default: 'Paris' }, days: { type: 'number' } },
            },
        }) as { manifest: Parameters<typeof pluginSettingsValues>[0] }
    ).manifest;

    it('fills declared defaults, prefers saved values and never passes undeclared or reserved keys', () => {
        expect(pluginSettingsValues(manifest, {})).toEqual({ city: 'Paris' });
        expect(pluginSettingsValues(manifest, { city: 'Rome', days: 3, other: 1, __runtime: { a: 1 } })).toEqual({
            city: 'Rome',
            days: 3,
        });
    });
});

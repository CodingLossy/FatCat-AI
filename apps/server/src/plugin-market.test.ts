// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件市场(ADR 0040 PR 4):用测试时生成的密钥对签名的假索引、本机 https 假服务器,全程不联网。
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { gzipSync } from 'node:zlib';
import {
    EgressTargetList,
    PluginDetail,
    PluginMarketListing,
    PluginPrepared,
    PluginView,
    pageOf,
} from '@fatcat-ai/shared';
import type { MarketConfig } from '@fatcat-ai/tools/market';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MarketService } from './plugin-market.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const fixtures = fileURLToPath(new URL('../../../packages/tools/src/plugins/fixtures/', import.meta.url));
// 测试用的自签证书(只用于本机假服务器,仓库里没有任何签名私钥)
const tls = (await import(new URL('test-tls.ts', `file://${fixtures}`).href)) as {
    TEST_TLS_CERT: string;
    TEST_TLS_KEY: string;
};

// ───────── 最小的 ustar 生成器:可以故意写出恶意条目 ─────────
interface Entry {
    name: string;
    data?: string;
    type?: string;
    linkName?: string;
}
function tgz(entries: Entry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.data ?? '');
        const block = Buffer.alloc(512);
        block.write(e.name, 0);
        block.write('0000644\0', 100);
        block.write(data.length.toString(8).padStart(11, '0'), 124);
        block.fill(0x20, 148, 156);
        block[156] = (e.type ?? '0').charCodeAt(0);
        block.write(e.linkName ?? '', 157);
        block.write('ustar\0', 257);
        let sum = 0;
        for (const byte of block) sum += byte;
        block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        parts.push(block, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
}

const manifest = JSON.parse(readFileSync(join(fixtures, 'plugin.json'), 'utf8')) as Record<string, unknown>;
const pluginJs = readFileSync(join(fixtures, 'probe-plugin.js'), 'utf8');
const goodFiles: Entry[] = [
    { name: 'plugin.json', data: JSON.stringify(manifest) },
    { name: 'probe-plugin.js', data: pluginJs },
];

// ───────── 测试密钥(每次运行现生成) ─────────
interface Signer {
    keyId: string;
    publicKey: string;
    privateKey: KeyObject;
}
function makeSigner(keyId: string): Signer {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        keyId,
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
        privateKey,
    };
}
const main = makeSigner('test-main');
const backup = makeSigner('test-backup');

// ───────── 假市场服务器 ─────────
let server: Server;
let other: Server;
let port = 0;
let otherPort = 0;
let otherHits = 0;
let requests: string[] = [];
let previousCAs: string[] = [];
let packages = new Map<string, Buffer>();
let indexBytes = Buffer.alloc(0);
let indexSigner: Signer = main;
let signAs: string | undefined;
let signWith: Signer | undefined;
let mode: Record<string, 'redirect-offsite' | 'cut' | undefined> = {};
let indexStatus = 200;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface VersionSpec {
    version?: string;
    file?: string;
    bytes?: Buffer;
    sha256?: string;
    size?: number;
    yanked?: boolean;
    permissions?: unknown;
    instructionOnly?: boolean;
}

function makeIndex(
    opts: {
        serial?: number;
        expiresAt?: string;
        versions?: VersionSpec[];
        market?: string;
        generatedAt?: string;
        skills?: { id: string; description: string }[];
    } = {},
) {
    const versions = (opts.versions ?? [{}]).map((v) => {
        const file = v.file ?? 'probe-0.1.0.tgz';
        const bytes = v.bytes ?? packages.get(file) ?? tgz(goodFiles);
        packages.set(file, bytes);
        return {
            version: v.version ?? '0.1.0',
            engines: { fatcat: '>=0.0.0' },
            url: `https://ok.test:${port}/pkgs/${file}`,
            size: v.size ?? bytes.length,
            sha256: v.sha256 ?? sha(bytes),
            permissions: v.permissions ?? manifest.permissions,
            publishedAt: '2026-11-18T00:00:00Z',
            yanked: v.yanked ?? false,
            yankedReason: v.yanked ? 'found a bug' : null,
            ...(v.instructionOnly === undefined ? {} : { instructionOnly: v.instructionOnly }),
        };
    });
    return {
        formatVersion: 1,
        market: opts.market ?? 'official',
        serial: opts.serial ?? 1,
        generatedAt: opts.generatedAt ?? '2026-11-18T00:00:00Z',
        expiresAt: opts.expiresAt ?? '2999-01-01T00:00:00Z',
        downloadHosts: ['ok.test'],
        plugins: [
            {
                id: 'probe',
                name: { en: 'Probe' },
                description: { en: 'Test plugin' },
                author: 'Test',
                license: 'Apache-2.0',
                versions,
                ...(opts.skills ? { skills: opts.skills } : {}),
            },
        ],
    };
}
function publish(index: unknown, signer: Signer = main) {
    indexBytes = Buffer.from(JSON.stringify(index));
    indexSigner = signer;
}

const listen = (s: Server) =>
    new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port)));

beforeAll(async () => {
    previousCAs = getCACertificates('default');
    setDefaultCACertificates([...previousCAs, tls.TEST_TLS_CERT]);
    other = createServer({ key: tls.TEST_TLS_KEY, cert: tls.TEST_TLS_CERT }, (_req, res) => {
        otherHits++;
        res.end('other');
    });
    otherPort = await listen(other);
    server = createServer({ key: tls.TEST_TLS_KEY, cert: tls.TEST_TLS_CERT }, (req, res) => {
        const path = req.url ?? '/';
        requests.push(path);
        if ((path === '/index.json' || path === '/index.json.sig') && indexStatus !== 200) {
            res.statusCode = indexStatus;
            res.end('unavailable');
        } else if (path === '/index.json') res.end(indexBytes);
        else if (path === '/index.json.sig') {
            const signer = signWith ?? indexSigner;
            res.end(
                JSON.stringify({
                    keyId: signAs ?? signer.keyId,
                    alg: 'ed25519',
                    sig: sign(null, indexBytes, signer.privateKey).toString('base64'),
                }),
            );
        } else if (path.startsWith('/pkgs/')) {
            const name = path.slice(6);
            const bytes = packages.get(name);
            if (mode[name] === 'redirect-offsite') {
                res.statusCode = 302;
                res.setHeader('location', `https://evil.test:${otherPort}/x.tgz`);
                res.end();
            } else if (mode[name] === 'cut') {
                res.writeHead(200, { 'content-length': String(bytes?.length ?? 0) });
                res.write((bytes ?? Buffer.alloc(0)).subarray(0, 40));
                setTimeout(() => res.destroy(), 20);
            } else if (bytes) res.end(bytes);
            else {
                res.statusCode = 404;
                res.end('missing');
            }
        } else {
            res.statusCode = 404;
            res.end('missing');
        }
    });
    port = await listen(server);
});

afterAll(async () => {
    setDefaultCACertificates(previousCAs);
    await Promise.all([server, other].map((s) => new Promise((done) => s.close(done))));
});

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
    requests = [];
    otherHits = 0;
    packages = new Map();
    mode = {};
    signAs = undefined;
    signWith = undefined;
    indexStatus = 200;
});

async function setup(markets?: MarketConfig[]) {
    const market: MarketConfig = {
        id: 'official',
        indexUrl: `https://ok.test:${port}/index.json`,
        keys: [
            { keyId: main.keyId, publicKey: main.publicKey },
            { keyId: backup.keyId, publicKey: backup.publicKey },
        ],
        official: true,
    };
    s = await createTestServer(
        {},
        {
            pluginMarket: {
                markets: markets ?? [market],
                net: {
                    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
                    isBlocked: (a) => a !== '127.0.0.1',
                },
            },
        },
    );
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const send = (method: string, p: string, body?: unknown) =>
        s.app.request(p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const refresh = async () =>
        PluginMarketListing.parse(await (await send('POST', '/api/v1/plugins/market/refresh')).json());
    const browse = async () => PluginMarketListing.parse(await (await send('GET', '/api/v1/plugins/market')).json());
    const prepare = (version = '0.1.0') =>
        send('POST', '/api/v1/plugins/prepare', {
            source: { kind: 'market', market: 'official', id: 'probe', version },
        });
    const plugins = async () => pageOf(PluginView).parse(await (await send('GET', '/api/v1/plugins')).json()).items;
    const staged = () => {
        const dir = join(s.dir, 'plugins', '.staging');
        return existsSync(dir) ? readdirSync(dir) : [];
    };
    const events = () =>
        s.conn.sqlite
            .prepare<[], { kind: string; detail: string | null; pluginId: string }>(
                'SELECT kind, detail, plugin_id AS pluginId FROM plugin_events ORDER BY at, id',
            )
            .all();
    return { send, refresh, browse, prepare, plugins, staged, events };
}

describe('插件市场', () => {
    it('主用与备用公钥签的索引都接受,验证后能浏览并安装,界面标注已审核、不再是未签名', async () => {
        for (const signer of [main, backup]) {
            packages = new Map();
            requests = [];
            publish(makeIndex({ serial: 1 }), signer);
            const { refresh, browse, prepare, send, plugins, staged } = await setup();
            // 打开市场页之前不下载:没有缓存时列表是空的、状态 unavailable
            expect((await browse()).markets[0]).toMatchObject({ state: 'unavailable', keyId: null });
            expect(requests).toEqual([]);

            const listing = await refresh();
            expect(listing.markets[0]).toMatchObject({ id: 'official', state: 'ok', keyId: signer.keyId, serial: 1 });
            expect(listing.plugins).toHaveLength(1);
            expect(listing.plugins[0]).toMatchObject({ id: 'probe', installed: null });
            expect(listing.plugins[0]?.versions[0]).toMatchObject({
                version: '0.1.0',
                compatible: true,
                instructionOnly: false,
            });
            expect(listing.plugins[0]?.skills).toEqual([]);

            const res = await prepare();
            expect(res.status).toBe(200);
            const prepared = PluginPrepared.parse(await res.json());
            expect(prepared).toMatchObject({ unreviewed: false, market: { id: 'official', keyId: signer.keyId } });
            expect(prepared.protections.find((p) => p.key === 'review')?.level).toBe('layered');
            expect(staged()).toHaveLength(1);

            const installed = await send('POST', '/api/v1/plugins/install', {
                stagingId: prepared.stagingId,
                accept: true,
            });
            expect(installed.status).toBe(201);
            expect(staged()).toEqual([]);
            const [view] = await plugins();
            expect(view).toMatchObject({
                id: 'probe',
                sourceKind: 'market',
                sourceRef: 'official:probe@0.1.0',
                signedKeyId: signer.keyId,
                unreviewed: false,
                yanked: null,
                instructionOnly: false,
            });
            expect(
                PluginDetail.parse(await (await send('GET', '/api/v1/plugins/probe')).json()).protections.length,
            ).toBeGreaterThan(0);
            expect((await browse()).plugins[0]?.installed).toMatchObject({ version: '0.1.0' });
            await s.cleanup();
        }
    });

    it('索引里的技能与「纯指令」标记原样带到市场页(ADR 0048 第 9 节)', async () => {
        publish(
            makeIndex({
                versions: [{ instructionOnly: true }],
                skills: [{ id: 'minutes', description: 'Use when the user asks to turn notes into minutes' }],
            }),
        );
        const { refresh } = await setup();
        const [plugin] = (await refresh()).plugins;
        expect(plugin?.versions[0]?.instructionOnly).toBe(true);
        expect(plugin?.skills).toEqual([
            { id: 'minutes', description: 'Use when the user asks to turn notes into minutes' },
        ]);
    });

    it('签名错误、未知 keyId、serial 回退、过期索引都被拒绝,缓存里的旧索引继续可用并写 market-rejected', async () => {
        publish(makeIndex({ serial: 5 }));
        const { refresh, events } = await setup();
        expect((await refresh()).markets[0]).toMatchObject({ state: 'ok', serial: 5 });

        const bad: [string, () => void, string][] = [
            [
                'wrong signature',
                () => (signWith = backup) && (signAs = main.keyId) && undefined,
                'index_signature_invalid',
            ],
            ['unknown key', () => (signAs = 'nobody-2026'), 'index_unknown_key'],
            ['rollback', () => publish(makeIndex({ serial: 4 })), 'index_rollback'],
            ['expired', () => publish(makeIndex({ serial: 9, expiresAt: '2020-01-01T00:00:00Z' })), 'index_expired'],
            ['wrong market', () => publish(makeIndex({ serial: 9, market: 'other' })), 'index_wrong_market'],
        ];
        for (const [, arrange, code] of bad) {
            signAs = undefined;
            signWith = undefined;
            publish(makeIndex({ serial: 6 }));
            arrange();
            const listing = await refresh();
            expect(listing.markets[0]).toMatchObject({ state: 'stale', serial: 5, error: { code } });
            expect(listing.plugins).toHaveLength(1); // 旧索引仍然可以浏览
        }
        expect(
            events()
                .filter((e) => e.kind === 'market-rejected')
                .map((e) => e.detail),
        ).toEqual(bad.map(([, , code]) => code));
        expect(events().every((e) => e.pluginId === 'market:official' || e.kind !== 'market-rejected')).toBe(true);

        // 同一个 serial 可以再次接受(重新签名)
        signAs = undefined;
        signWith = undefined;
        publish(makeIndex({ serial: 5 }));
        expect((await refresh()).markets[0]).toMatchObject({ state: 'ok', serial: 5, error: null });
    });

    it('同一个 serial 内容变了就拒绝;缓存文件丢失后最高 serial 仍然防回滚', async () => {
        publish(makeIndex({ serial: 7 }));
        const { refresh } = await setup();
        expect((await refresh()).markets[0]).toMatchObject({ state: 'ok', serial: 7 });

        publish(makeIndex({ serial: 7, generatedAt: '2026-11-19T00:00:00Z' }));
        expect((await refresh()).markets[0]).toMatchObject({ state: 'stale', error: { code: 'index_rollback' } });

        // 缓存的索引与签名被删(或换索引中途失败):没有缓存了,但见过 serial 7
        const dir = join(s.dir, 'plugins', '.market');
        rmSync(join(dir, 'official.json'));
        rmSync(join(dir, 'official.sig'));
        publish(makeIndex({ serial: 6 }));
        const reopened = new MarketService({
            repos: s.repos,
            dataDir: s.dir,
            markets: [
                {
                    id: 'official',
                    indexUrl: `https://ok.test:${port}/index.json`,
                    keys: [{ keyId: main.keyId, publicKey: main.publicKey }],
                    official: true,
                },
            ],
            net: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isBlocked: (a) => a !== '127.0.0.1' },
        });
        const ownerId = s.repos.owners.ids()[0]!;
        await reopened.refresh(ownerId);
        expect(reopened.listing(ownerId, { coreVersion: '1.1.0', installed: () => null }).markets[0]).toMatchObject({
            error: { code: 'index_rollback' },
        });
        publish(makeIndex({ serial: 8 }));
        await reopened.refresh(ownerId);
        expect(reopened.listing(ownerId, { coreVersion: '1.1.0', installed: () => null }).markets[0]).toMatchObject({
            state: 'ok',
            serial: 8,
        });
    });

    it('索引下载失败时继续用缓存(仍可安装);从没成功过时市场页只显示错误,不能安装', async () => {
        publish(makeIndex());
        const { refresh, prepare } = await setup();
        await refresh();
        indexStatus = 503;
        const listing = await refresh();
        expect(listing.markets[0]).toMatchObject({ state: 'stale', error: { code: 'index_download_failed' } });
        expect(listing.plugins).toHaveLength(1);
        expect((await prepare()).status).toBe(200);

        await s.cleanup();
        const fresh = await setup();
        const none = await fresh.refresh();
        expect(none.markets[0]).toMatchObject({ state: 'unavailable', error: { code: 'index_download_failed' } });
        expect(none.plugins).toEqual([]);
        expect((await fresh.prepare()).status).toBe(503);
        // 下载失败是网络问题,不记 market-rejected
        expect(fresh.events()).toEqual([]);
    });

    it('下载失败不影响缓存:缓存里的索引过期后只显示错误,不能安装', async () => {
        publish(makeIndex({ serial: 1, expiresAt: new Date(Date.now() + 1500).toISOString() }));
        const { refresh, browse, prepare } = await setup();
        expect((await refresh()).markets[0]?.state).toBe('ok');
        await new Promise((r) => setTimeout(r, 1700));
        const listing = await browse();
        expect(listing.markets[0]).toMatchObject({ state: 'unavailable', error: { code: 'index_expired' } });
        expect(listing.plugins).toEqual([]);
        expect((await prepare()).status).toBe(503);
    });

    it('sha256 不符:报 plugin_checksum_mismatch、写事件、暂存目录清空、已安装的东西不变', async () => {
        publish(makeIndex({ versions: [{ sha256: 'a'.repeat(64) }] }));
        const { refresh, prepare, staged, plugins, events } = await setup();
        await refresh();
        const res = await prepare();
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'plugin_checksum_mismatch' });
        expect(staged()).toEqual([]);
        expect(await plugins()).toEqual([]);
        expect(events().map((e) => e.kind)).toContain('checksum-mismatch');
    });

    it.each([
        ['a symbolic link', [{ name: 'link', type: '2', linkName: '/etc/passwd' }]],
        ['a parent directory', [{ name: '../escape.js', data: 'x' }]],
        ['a Windows drive letter', [{ name: 'C:evil.js', data: 'x' }]],
        ['a reserved Windows name', [{ name: 'CON.js', data: 'x' }]],
        ['a path that differs only in case', [{ name: 'PLUGIN.JSON', data: '{}' }]],
    ] as [string, Entry[]][])('包里有 %s:整体拒绝,暂存目录清空', async (_label, extra) => {
        publish(makeIndex({ versions: [{ bytes: tgz([...goodFiles, ...extra]), file: 'bad.tgz' }] }));
        const { refresh, prepare, staged, plugins } = await setup();
        await refresh();
        const res = await prepare();
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'plugin_package_invalid' });
        expect(staged()).toEqual([]);
        expect(await plugins()).toEqual([]);
    });

    it('压缩炸弹与超过声明大小的包被拒绝', async () => {
        const bomb = tgz([...goodFiles, { name: 'zeros.bin', data: '\0'.repeat(8 * 1024 * 1024) }]);
        publish(makeIndex({ versions: [{ bytes: bomb, file: 'bomb.tgz' }] }));
        const { refresh, prepare, staged } = await setup();
        await refresh();
        const res = await prepare();
        expect(res.status).toBe(400);
        expect((await res.json()) as { detail: string }).toMatchObject({ detail: expect.stringMatching(/bomb/) });
        expect(staged()).toEqual([]);

        const big = tgz(goodFiles);
        publish(makeIndex({ serial: 2, versions: [{ bytes: big, file: 'big.tgz', size: big.length - 10 }] }));
        await refresh();
        expect((await prepare()).status).toBe(413);
        expect(staged()).toEqual([]);
    });

    it('下载被重定向到 downloadHosts 之外:被拒绝,那台主机没有收到请求', async () => {
        publish(makeIndex({ versions: [{ file: 'redir.tgz' }] }));
        mode['redir.tgz'] = 'redirect-offsite';
        const { refresh, prepare, staged } = await setup();
        await refresh();
        const res = await prepare();
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ code: 'plugin_download_failed' });
        expect(otherHits).toBe(0);
        expect(staged()).toEqual([]);
    });

    it('下载中途断开:报 plugin_download_failed,暂存目录被清理', async () => {
        publish(makeIndex({ versions: [{ file: 'cut.tgz' }] }));
        const { refresh, prepare, staged } = await setup();
        await refresh();
        mode['cut.tgz'] = 'cut';
        expect((await prepare()).status).toBe(502);
        expect(staged()).toEqual([]);
    });

    it('包内 plugin.json 的权限或版本与索引不一致:plugin_manifest_mismatch', async () => {
        const widened = { ...manifest, permissions: { ...(manifest.permissions as object), net: ['example.com'] } };
        const files = [{ name: 'plugin.json', data: JSON.stringify(widened) }, goodFiles[1]!];
        publish(makeIndex({ versions: [{ bytes: tgz(files), file: 'wide.tgz' }] }));
        const { refresh, prepare, staged, plugins } = await setup();
        await refresh();
        const res = await prepare();
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'plugin_manifest_mismatch' });
        expect(staged()).toEqual([]);
        expect(await plugins()).toEqual([]);
    });

    it('被下架的版本不展示、不能安装;已安装的版本被下架后只显示警告,不自动停用', async () => {
        publish(makeIndex({ serial: 1 }));
        const { refresh, browse, prepare, send, plugins } = await setup();
        await refresh();
        const prepared = PluginPrepared.parse(await (await prepare()).json());
        await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true });

        publish(makeIndex({ serial: 2, versions: [{ yanked: true }, { version: '0.2.0', file: 'probe-0.2.0.tgz' }] }));
        await refresh();
        const listing = await browse();
        expect(listing.plugins[0]?.versions.map((v) => v.version)).toEqual(['0.2.0']);
        expect((await prepare('0.1.0')).status).toBe(409);
        expect(await (await prepare('0.1.0')).json()).toMatchObject({ code: 'plugin_yanked' });
        const [view] = await plugins();
        expect(view).toMatchObject({ yanked: { reason: 'found a bug' } });
        expect(view?.state).not.toBe('uninstalled');
    });

    it('关闭「插件市场」后:浏览、刷新、安装都回 market_disabled,不发任何请求,外连清单里没有市场地址', async () => {
        publish(makeIndex());
        const { refresh, send } = await setup();
        await refresh();
        const targets = async () =>
            EgressTargetList.parse(await (await send('GET', '/api/v1/settings/egress-targets')).json()).targets.filter(
                (t) => t.source.kind === 'plugin-market',
            );
        expect((await targets()).map((t) => t.origin)).toEqual([`https://ok.test`]);
        expect((await targets())[0]).toMatchObject({ category: 'plugin', enabled: true });

        expect((await send('PUT', '/api/v1/settings', { plugins: { marketEnabled: false } })).status).toBe(200);
        requests = [];
        for (const res of [
            await send('GET', '/api/v1/plugins/market'),
            await send('POST', '/api/v1/plugins/market/refresh'),
            await send('POST', '/api/v1/plugins/prepare', {
                source: { kind: 'market', market: 'official', id: 'probe', version: '0.1.0' },
            }),
        ]) {
            expect(res.status).toBe(409);
            expect(await res.json()).toMatchObject({ code: 'market_disabled' });
        }
        expect(requests).toEqual([]);
        expect(await targets()).toEqual([]);

        // 本地目录安装不受影响
        const local = await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: fixtures } });
        expect([200, 400]).toContain(local.status);
    });

    it('缓存文件被改动后(例如重启时)重新验签:当作没有缓存', async () => {
        publish(makeIndex());
        const { refresh } = await setup();
        await refresh();
        const path = join(s.dir, 'plugins', '.market', 'official.json');
        const ownerId = s.repos.owners.ids()[0]!;
        const reopen = () =>
            new MarketService({
                repos: s.repos,
                dataDir: s.dir,
                markets: [
                    {
                        id: 'official',
                        indexUrl: `https://ok.test:${port}/index.json`,
                        keys: [{ keyId: main.keyId, publicKey: main.publicKey }],
                        official: true,
                    },
                ],
            }).listing(ownerId, { coreVersion: '1.1.0', installed: () => null });
        expect(reopen().plugins).toHaveLength(1);
        writeFileSync(path, readFileSync(path, 'utf8').replace('Test plugin', 'Evil plugin'));
        expect(reopen()).toMatchObject({ plugins: [], markets: [{ state: 'unavailable', keyId: null }] });
    });

    it('一个插件不能占用保留 id「market」', async () => {
        const { PluginId } = await import('@fatcat-ai/shared');
        expect(PluginId.safeParse('market').success).toBe(false);
        expect(PluginId.safeParse('market-news').success).toBe(true);
    });
});

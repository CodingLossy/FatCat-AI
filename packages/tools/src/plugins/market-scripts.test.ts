// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// scripts/plugins/ 里的两个脚本(本机签名、索引仓库 CI 检查)与客户端用的是同一套格式:
// 这里用测试时生成的密钥对,验证脚本签出的索引能被客户端的 verifyIndex 接受,以及 CI 检查会拒绝哪些改动。
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginIndex } from '@fatcat-ai/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTgz } from './fixtures/tgz.js';
import { OFFICIAL_MARKET_KEYS, verifyIndex } from './market.js';
import { extractTgz } from './tar.js';
import { validateStagedPackage } from './package.js';

const scriptsDir = fileURLToPath(new URL('../../../../scripts/plugins/', import.meta.url));
// 动态导入:脚本是没有类型声明的 .mjs
/* eslint-disable @typescript-eslint/no-explicit-any */
const signer: any = await import(pathToFileURL(join(scriptsDir, 'sign-index.mjs')).href);
const checker: any = await import(pathToFileURL(join(scriptsDir, 'check-index.mjs')).href);
/* eslint-enable @typescript-eslint/no-explicit-any */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-scripts-'));
    dirs.push(dir);
    return dir;
};

const generated = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        raw: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    };
};

const indexOf = (over: Record<string, unknown> = {}) =>
    Buffer.from(
        JSON.stringify({
            formatVersion: 1,
            market: 'official',
            serial: 3,
            generatedAt: '2026-11-18T00:00:00Z',
            expiresAt: '2999-01-01T00:00:00Z',
            downloadHosts: ['ok.test'],
            plugins: [],
            ...over,
        }),
    );

describe('sign-index.mjs', () => {
    it('embeds exactly the two official public keys the client trusts', () => {
        expect(signer.OFFICIAL_PUBLIC_KEYS).toEqual(
            Object.fromEntries(OFFICIAL_MARKET_KEYS.map((k) => [k.keyId, k.publicKey])),
        );
    });

    it('signs the raw bytes in the format the client verifies', () => {
        const key = generated();
        const bytes = indexOf();
        const result = signer.signIndexBytes({
            indexBytes: bytes,
            keyPem: key.pem,
            keyId: 'test-main',
            allowUnknownKeyId: true,
        });
        expect(result.publicKey).toBe(key.raw);
        const verified = verifyIndex(
            bytes,
            Buffer.from(result.signature),
            [{ keyId: 'test-main', publicKey: key.raw }],
            'official',
        );
        expect(verified).toMatchObject({ keyId: 'test-main', index: { serial: 3 } });
        expect(signer.verifySignature(bytes, result.signature, key.raw)).toBe(true);
        // 一个字节之差就验不过
        expect(signer.verifySignature(Buffer.concat([bytes, Buffer.from(' ')]), result.signature, key.raw)).toBe(false);
    });

    it('refuses a key that is not the official one for that keyId, unknown key ids, bad keys and bad indexes', () => {
        const key = generated();
        const run = (over: Record<string, unknown>) =>
            signer.signIndexBytes({ indexBytes: indexOf(), keyPem: key.pem, keyId: 'fatcat-main-2026', ...over });
        expect(() => run({})).toThrow(/does not belong to fatcat-main-2026/);
        expect(() => run({ keyId: 'someone-else' })).toThrow(/not one of the official keys/);
        expect(() => run({ keyPem: 'not a key' })).toThrow(/not a PEM private key/);
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
            type: 'pkcs8',
            format: 'pem',
        });
        expect(() => run({ keyPem: rsa, allowUnknownKeyId: true })).toThrow(/Ed25519/);
        expect(() =>
            run({ indexBytes: indexOf({ expiresAt: '2020-01-01T00:00:00Z' }), allowUnknownKeyId: true }),
        ).toThrow(/expiresAt/);
        expect(() => run({ indexBytes: Buffer.from('nope'), allowUnknownKeyId: true })).toThrow(/not valid JSON/);
        expect(() => run({ indexBytes: indexOf({ formatVersion: 2 }), allowUnknownKeyId: true })).toThrow(
            /formatVersion/,
        );
    });

    it('--verify checks a published pair against the built-in public keys only', () => {
        const key = generated();
        const bytes = indexOf();
        const sig = signer.signIndexBytes({
            indexBytes: bytes,
            keyPem: key.pem,
            keyId: 'test-main',
            allowUnknownKeyId: true,
        });
        // 测试密钥不是官方密钥:--verify 只认官方的两把
        expect(() => signer.verifyOfficial(bytes, sig.signature)).toThrow(/unknown keyId/);
        const forged = JSON.stringify({
            keyId: 'fatcat-main-2026',
            alg: 'ed25519',
            sig: JSON.parse(sig.signature).sig,
        });
        expect(() => signer.verifyOfficial(bytes, forged)).toThrow(/does not match/);
        expect(() => signer.verifyOfficial(bytes, 'nope')).toThrow(/not valid JSON/);
    });

    it('reads the key only from a file given on the command line and refuses to run in CI', () => {
        const dir = tmp();
        const key = generated();
        writeFileSync(join(dir, 'key.pem'), key.pem, { mode: 0o600 });
        writeFileSync(join(dir, 'index.json'), indexOf());
        const script = join(scriptsDir, 'sign-index.mjs');
        const clean = { PATH: process.env.PATH ?? '' };
        // 没有 --key:即使环境变量里有私钥也不会用
        expect(() =>
            execFileSync(process.execPath, [script, '--key-id', 'test-main', '--index', join(dir, 'index.json')], {
                env: { ...clean, FATCAT_SIGNING_KEY: key.pem },
                stdio: 'pipe',
            }),
        ).toThrow(/usage/);
        const args = [
            script,
            '--key',
            join(dir, 'key.pem'),
            '--key-id',
            'test-main',
            '--allow-unknown-key-id',
            '--index',
            join(dir, 'index.json'),
        ];
        expect(() => execFileSync(process.execPath, args, { env: { ...clean, CI: 'true' }, stdio: 'pipe' })).toThrow(
            /refusing to run in CI/,
        );
        execFileSync(process.execPath, args, { env: clean, stdio: 'pipe' });
        const sig = readFileSync(join(dir, 'index.json.sig'), 'utf8');
        expect(signer.verifySignature(indexOf(), sig, key.raw)).toBe(true);
        expect(JSON.parse(sig)).toMatchObject({ keyId: 'test-main', alg: 'ed25519' });
    });
});

describe('check-index.mjs', () => {
    const manifest = {
        manifestVersion: 1,
        id: 'weather',
        version: '1.0.0',
        name: { en: 'Weather' },
        description: { en: 'Forecasts' },
        author: 'Example',
        license: 'MIT',
        engines: { fatcat: '>=1.1.0' },
        entry: { type: 'mcp-stdio', main: 'server.js' },
        permissions: { tools: [{ name: 'forecast', risk: 'read' }], net: ['api.example.com'] },
    };
    const goodFiles = [
        { name: 'plugin.json', data: JSON.stringify(manifest) },
        { name: 'server.js', data: "console.log('hello');\n" },
    ];
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const entryFor = (bytes: Buffer, over: Record<string, unknown> = {}) => ({
        id: 'weather',
        name: { en: 'Weather' },
        description: { en: 'Forecasts' },
        author: 'Example',
        license: 'MIT',
        versions: [
            {
                version: '1.0.0',
                engines: { fatcat: '>=1.1.0' },
                url: 'https://ok.test/weather-1.0.0.tgz',
                size: bytes.length,
                sha256: sha(bytes),
                permissions: manifest.permissions,
                publishedAt: '2026-11-18T00:00:00Z',
                yanked: false,
                yankedReason: null,
                ...over,
            },
        ],
    });
    const deps = { PluginIndex, extractTgz, validateStagedPackage };
    const run = (plugins: unknown[], bytes: Buffer, extra: { previous?: Buffer; serial?: number } = {}) =>
        checker.checkIndex({
            indexBytes: indexOf({ plugins, serial: extra.serial ?? 3 }),
            previousBytes: extra.previous ?? null,
            deps,
            download: async () => bytes,
        }) as Promise<{ errors: string[]; checked: string[] }>;

    it('accepts a package whose checksum, manifest and permissions match the entry', async () => {
        const bytes = makeTgz(goodFiles);
        const result = await run([entryFor(bytes)], bytes);
        expect(result).toEqual({ errors: [], checked: ['weather@1.0.0'] });
    });

    it('rejects a wrong sha256, a manifest that disagrees with the entry and a package with a symbolic link', async () => {
        const bytes = makeTgz(goodFiles);
        expect((await run([entryFor(bytes, { sha256: 'a'.repeat(64) })], bytes)).errors.join('\n')).toMatch(
            /sha256 is/,
        );
        const widened = makeTgz([
            {
                name: 'plugin.json',
                data: JSON.stringify({ ...manifest, permissions: { ...manifest.permissions, net: ['evil.test'] } }),
            },
            goodFiles[1]!,
        ]);
        expect((await run([entryFor(widened)], widened)).errors.join('\n')).toMatch(/permissions do not match/);
        const linked = makeTgz([...goodFiles, { name: 'x', type: '2', linkName: '/etc/passwd' }]);
        expect((await run([entryFor(linked)], linked)).errors.join('\n')).toMatch(/symbolic link/);
    });

    it('static scan flags forbidden modules, process.binding, process.dlopen, eval and new Function', async () => {
        const findings = checker.staticScan([
            {
                path: 'server.js',
                text: [
                    "const cp = require('node:child_process');",
                    "import net from 'net';",
                    'process.binding("tcp_wrap");',
                    'process.dlopen(m, f);',
                    'eval("x");',
                    'new Function("return 1");',
                    "const ok = require('node:path');",
                ].join('\n'),
            },
        ]) as string[];
        expect(findings).toHaveLength(6);
        expect(findings.join('\n')).not.toMatch(/node:path/);
        const bytes = makeTgz([goodFiles[0]!, { name: 'server.js', data: "require('node:http');\n" }]);
        expect((await run([entryFor(bytes)], bytes)).errors.join('\n')).toMatch(/forbidden module/);
    });

    it('compares with the previous index: no removals, no rewrites, no un-yanking, serial moves forward', async () => {
        const bytes = makeTgz(goodFiles);
        const previous = indexOf({ plugins: [entryFor(bytes)], serial: 3 });
        const errorsFor = async (plugins: unknown[], serial = 4) =>
            (await run(plugins, bytes, { previous, serial })).errors.join('\n');
        expect(await errorsFor([entryFor(bytes)])).toBe('');
        expect(await errorsFor([])).toMatch(/plugin was removed/);
        expect(
            await errorsFor([{ ...entryFor(bytes), versions: [{ ...entryFor(bytes).versions[0], version: '1.0.1' }] }]),
        ).toMatch(/version was removed/);
        expect(await errorsFor([entryFor(bytes, { sha256: 'b'.repeat(64) })])).toMatch(/sha256 must not change/);
        expect(await errorsFor([entryFor(bytes)], 2)).toMatch(/serial went backwards/);
        // 下架:允许;已下架的不能恢复
        const yanked = entryFor(bytes, { yanked: true, yankedReason: 'bug' });
        expect(await errorsFor([yanked])).toBe('');
        const yankedPrevious = indexOf({ plugins: [yanked], serial: 3 });
        const restored = await run([entryFor(bytes)], bytes, { previous: yankedPrevious, serial: 4 });
        expect(restored.errors.join('\n')).toMatch(/cannot be restored/);
        // 内容变了但 serial 没涨
        expect(await errorsFor([yanked], 3)).toMatch(/serial did not increase/);
    });

    it('re-downloads only new versions when a previous index is given', async () => {
        const bytes = makeTgz(goodFiles);
        const previous = indexOf({ plugins: [entryFor(bytes)], serial: 3 });
        const second = makeTgz([
            { name: 'plugin.json', data: JSON.stringify({ ...manifest, version: '1.1.0' }) },
            goodFiles[1]!,
        ]);
        const both = {
            ...entryFor(bytes),
            versions: [
                entryFor(bytes).versions[0],
                { ...entryFor(second).versions[0], version: '1.1.0', url: 'https://ok.test/weather-1.1.0.tgz' },
            ],
        };
        const urls: string[] = [];
        const result = await checker.checkIndex({
            indexBytes: indexOf({ plugins: [both], serial: 4 }),
            previousBytes: previous,
            deps,
            download: async (url: string) => {
                urls.push(url);
                return second;
            },
        });
        expect(result.errors).toEqual([]);
        expect(urls).toEqual(['https://ok.test/weather-1.1.0.tgz']);
    });
});

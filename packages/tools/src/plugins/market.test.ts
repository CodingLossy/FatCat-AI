// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './fixtures/test-tls.js';
import {
    downloadPackage,
    fetchIndexFiles,
    MarketError,
    OFFICIAL_MARKET_KEYS,
    publicKeyFromRaw,
    verifyIndex,
    type MarketConfig,
    type MarketKey,
} from './market.js';

// 测试用的密钥对在测试时生成,仓库里没有任何私钥
function makeKey(keyId: string): { key: MarketKey; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return { key: { keyId, publicKey: raw.toString('base64') }, privateKey };
}

const main = makeKey('test-main');
const backup = makeKey('test-backup');
const keys = [main.key, backup.key];

function indexJson(overrides: Record<string, unknown> = {}, host = 'ok.test'): Buffer {
    return Buffer.from(
        JSON.stringify({
            formatVersion: 1,
            market: 'official',
            serial: 1,
            generatedAt: '2026-11-18T00:00:00Z',
            expiresAt: '2026-12-18T00:00:00Z',
            downloadHosts: [host],
            plugins: [],
            ...overrides,
        }),
    );
}

function signature(bytes: Buffer, signer: { key: MarketKey; privateKey: KeyObject }, keyId = signer.key.keyId): Buffer {
    return Buffer.from(
        JSON.stringify({ keyId, alg: 'ed25519', sig: sign(null, bytes, signer.privateKey).toString('base64') }),
    );
}

describe('built-in official keys', () => {
    it('are two distinct 32-byte Ed25519 public keys', () => {
        expect(OFFICIAL_MARKET_KEYS.map((k) => k.keyId)).toEqual(['fatcat-main-2026', 'fatcat-backup-2026']);
        for (const key of OFFICIAL_MARKET_KEYS) {
            expect(Buffer.from(key.publicKey, 'base64')).toHaveLength(32);
            expect(publicKeyFromRaw(key.publicKey).asymmetricKeyType).toBe('ed25519');
        }
        expect(OFFICIAL_MARKET_KEYS[0]?.publicKey).not.toBe(OFFICIAL_MARKET_KEYS[1]?.publicKey);
    });
});

describe('verifyIndex', () => {
    it('accepts an index signed by either the main or the backup key', () => {
        const bytes = indexJson();
        expect(verifyIndex(bytes, signature(bytes, main), keys, 'official').keyId).toBe('test-main');
        expect(verifyIndex(bytes, signature(bytes, backup), keys, 'official').keyId).toBe('test-backup');
    });

    it('rejects a signature made by a key the client does not know', () => {
        const bytes = indexJson();
        const stranger = makeKey('stranger');
        expect(() => verifyIndex(bytes, signature(bytes, stranger), keys, 'official')).toThrow(/unknown key/);
        // 声称是已知的 keyId,但签名是别人的
        expect(() => verifyIndex(bytes, signature(bytes, stranger, 'test-main'), keys, 'official')).toThrow(
            /does not match/,
        );
    });

    it('rejects an index that was changed after signing, one bit is enough', () => {
        const bytes = indexJson();
        const sig = signature(bytes, main);
        const tampered = Buffer.from(bytes);
        tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1;
        expect(() => verifyIndex(tampered, sig, keys, 'official')).toThrow(MarketError);
        expect(() => verifyIndex(tampered, sig, keys, 'official')).toThrow(/does not match/);
    });

    it('rejects malformed signature files and indexes that do not match the format', () => {
        const bytes = indexJson();
        expect(() => verifyIndex(bytes, Buffer.from('nope'), keys, 'official')).toThrow(/expected format/);
        expect(() => verifyIndex(bytes, Buffer.alloc(2048), keys, 'official')).toThrow(/too large/);
        const wrongFormat = indexJson({ formatVersion: 2 });
        expect(() => verifyIndex(wrongFormat, signature(wrongFormat, main), keys, 'official')).toThrow(
            /does not match the format/,
        );
        const notJson = Buffer.from('not json at all');
        expect(() => verifyIndex(notJson, signature(notJson, main), keys, 'official')).toThrow(/not valid JSON/);
        const other = indexJson({ market: 'other' });
        expect(() => verifyIndex(other, signature(other, main), keys, 'official')).toThrow(/for market "other"/);
    });

    it('checks the signature before parsing the content', () => {
        // 签名错误的垃圾内容报的是签名错误,不是 JSON 错误
        expect(() => verifyIndex(Buffer.from('{{{'), signature(Buffer.from('x'), main), keys, 'official')).toThrow(
            /does not match/,
        );
    });
});

describe('fetching the index and packages over https', () => {
    let server: Server;
    let other: Server;
    let port = 0;
    let otherPort = 0;
    let otherHits = 0;
    let previousCAs: string[] = [];
    const payload = Buffer.from('package-bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    const net = { resolve, isBlocked: (address: string) => address !== '127.0.0.1' };
    const listen = (s: Server) =>
        new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port)));

    beforeAll(async () => {
        previousCAs = getCACertificates('default');
        setDefaultCACertificates([...previousCAs, TEST_TLS_CERT]);
        other = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
            otherHits++;
            res.end('other');
        });
        otherPort = await listen(other);
        server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
            const path = req.url ?? '/';
            if (path === '/index.json') res.end(indexJson());
            else if (path === '/index.json.sig') res.end(signature(indexJson(), main));
            else if (path === '/pkg') res.end(payload);
            else if (path === '/redirect') {
                res.statusCode = 302;
                res.setHeader('location', `https://ok.test:${port}/pkg`);
                res.end();
            } else if (path === '/offsite') {
                res.statusCode = 302;
                res.setHeader('location', `https://evil.test:${otherPort}/pkg`);
                res.end();
            } else if (path === '/downgrade') {
                res.statusCode = 302;
                res.setHeader('location', `http://ok.test:${port}/pkg`);
                res.end();
            } else if (path === '/huge') {
                res.end(Buffer.alloc(100_000));
            } else if (path === '/slow-error') {
                res.statusCode = 503;
                res.end('busy');
            } else res.end('x');
        });
        port = await listen(server);
    });

    afterAll(async () => {
        setDefaultCACertificates(previousCAs);
        await Promise.all([server, other].map((s) => new Promise((done) => s.close(done))));
    });

    const market = (path = '/index.json'): MarketConfig => ({
        id: 'official',
        indexUrl: `https://ok.test:${port}${path}`,
        keys,
        official: false,
    });
    const version = (path: string, over: { size?: number; sha256?: string } = {}) => ({
        url: `https://ok.test:${port}${path}`,
        size: over.size ?? payload.length,
        sha256: over.sha256 ?? digest,
    });

    it('downloads index.json and its signature', async () => {
        const files = await fetchIndexFiles(market(), net);
        expect(verifyIndex(files.index, files.signature, keys, 'official').index.serial).toBe(1);
    });

    it('reports a missing file or a non-200 answer as index_download_failed', async () => {
        await expect(fetchIndexFiles(market('/slow-error'), net)).rejects.toMatchObject({
            code: 'index_download_failed',
        });
    });

    it('reports a host resolved into the fake-IP range as index_fake_ip_blocked', async () => {
        const fake = async () => [{ address: '198.18.0.7', family: 4 }];
        await expect(fetchIndexFiles(market(), { resolve: fake })).rejects.toMatchObject({
            code: 'index_fake_ip_blocked',
        });
    });
    });

    it('downloads a package whose size and sha256 match, following same-host redirects', async () => {
        expect((await downloadPackage(version('/pkg'), ['ok.test'], net)).equals(payload)).toBe(true);
        expect((await downloadPackage(version('/redirect'), ['ok.test'], net)).equals(payload)).toBe(true);
    });

    it('rejects a sha256 mismatch and a size that differs from the signed index', async () => {
        await expect(
            downloadPackage(version('/pkg', { sha256: 'a'.repeat(64) }), ['ok.test'], net),
        ).rejects.toMatchObject({ code: 'plugin_checksum_mismatch' });
        await expect(
            downloadPackage(version('/pkg', { size: payload.length + 5 }), ['ok.test'], net),
        ).rejects.toMatchObject({ code: 'plugin_checksum_mismatch' });
    });

    it('stops at the declared size instead of downloading everything', async () => {
        await expect(downloadPackage(version('/huge', { size: 1000 }), ['ok.test'], net)).rejects.toMatchObject({
            code: 'plugin_too_large',
        });
    });

    it('refuses hosts outside downloadHosts, including after a redirect, without contacting them', async () => {
        await expect(downloadPackage(version('/pkg'), ['elsewhere.test'], net)).rejects.toMatchObject({
            code: 'plugin_download_failed',
        });
        await expect(downloadPackage(version('/offsite'), ['ok.test'], net)).rejects.toThrow(
            /not an allowed download host/,
        );
        expect(otherHits).toBe(0);
    });

    it('refuses to leave https and answers with a stable code for HTTP errors', async () => {
        await expect(downloadPackage(version('/downgrade'), ['ok.test'], net)).rejects.toThrow(/only https/);
        await expect(downloadPackage(version('/slow-error'), ['ok.test'], net)).rejects.toMatchObject({
            code: 'plugin_download_failed',
        });
    });

    it('refuses addresses net-guard blocks, and fake-IP addresses unless the setting allows them', async () => {
        const fake = { resolve: async () => [{ address: '198.18.0.7', family: 4 }] };
        await expect(downloadPackage(version('/pkg'), ['ok.test'], fake)).rejects.toThrow(/fake-IP/);
        const loopback = { resolve };
        await expect(downloadPackage(version('/pkg'), ['ok.test'], loopback)).rejects.toThrow(/disallowed address/);
    });
});

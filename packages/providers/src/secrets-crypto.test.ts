// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    createMasterKeyResolver,
    decryptSecrets,
    encodeMasterKey,
    encryptSecrets,
    generateMasterKey,
    keyFingerprint,
    MasterKeyFormatError,
    parseMasterKey,
    SecretsEnvelopeError,
    SecretsKeyUnavailableError,
} from './secrets-crypto.js';

const KEY = Buffer.alloc(32, 7);
const PLAIN = "MODEL_KEY: 'sk-test-0000000000000000'\nILINK_TOKEN_A: 'tok-中文'\n";

/** 把信封的第 n 段(0 版本,1 nonce,2 密文,3 标签)换成 f(段)。 */
const tamper = (envelope: string, n: number, f: (part: string) => string) =>
    envelope
        .split(':')
        .map((p, i) => (i === n ? f(p) : p))
        .join(':');
const flip = (b64: string) => {
    const buf = Buffer.from(b64, 'base64url');
    buf[0] = buf[0]! ^ 1;
    return buf.toString('base64url');
};

describe('secrets envelope (fcsec1)', () => {
    it('round-trips, never contains the plaintext, and uses a fresh nonce each time', () => {
        const a = encryptSecrets(PLAIN, KEY);
        const b = encryptSecrets(PLAIN, KEY);
        expect(a.startsWith('fcsec1:')).toBe(true);
        expect(a.split(':')).toHaveLength(4);
        expect(a).not.toContain('sk-test');
        expect(decryptSecrets(a, KEY)).toBe(PLAIN);
        expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
        expect(a).not.toBe(b);
    });

    it('fails when the ciphertext, tag or nonce is changed, with the unified key-unavailable error', () => {
        const e = encryptSecrets(PLAIN, KEY);
        for (const n of [2, 3, 1]) {
            expect(() => decryptSecrets(tamper(e, n, flip), KEY)).toThrow(SecretsKeyUnavailableError);
        }
        expect(() => decryptSecrets(e, Buffer.alloc(32, 8))).toThrow('密钥不可用');
    });

    it('rejects a changed or unknown version and malformed envelopes', () => {
        const e = encryptSecrets(PLAIN, KEY);
        expect(() =>
            decryptSecrets(
                tamper(e, 0, () => 'fcsec2'),
                KEY,
            ),
        ).toThrow(SecretsEnvelopeError);
        expect(() => decryptSecrets('fcsec1:abc', KEY)).toThrow(SecretsEnvelopeError);
        expect(() => decryptSecrets('plain text', KEY)).toThrow(SecretsEnvelopeError);
        expect(() =>
            decryptSecrets(
                tamper(e, 1, (p) => p.slice(2)),
                KEY,
            ),
        ).toThrow(SecretsEnvelopeError);
    });
});

describe('master key', () => {
    const hex = 'ab'.repeat(32);
    const b64 = Buffer.alloc(32, 9).toString('base64');

    it('parses 64 hex or base64 of exactly 32 bytes and rejects everything else without echoing it', () => {
        expect(parseMasterKey(hex)).toEqual(Buffer.from(hex, 'hex'));
        expect(parseMasterKey(`${b64}\n`)).toEqual(Buffer.alloc(32, 9));
        expect(parseMasterKey(Buffer.alloc(32, 9).toString('base64url'))).toEqual(Buffer.alloc(32, 9));
        for (const bad of ['', 'short-secret-value', 'zz'.repeat(32), hex.slice(2), `${hex}00`]) {
            const attempt = () => parseMasterKey(bad);
            expect(attempt).toThrow(MasterKeyFormatError);
            try {
                attempt();
            } catch (error) {
                if (bad.length > 8) expect((error as Error).message).not.toContain(bad);
            }
        }
    });

    it('fingerprint is the first 8 hex digits of the SHA-256, not the key', () => {
        const fp = keyFingerprint(KEY);
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
        expect(KEY.toString('hex')).not.toContain(fp);
        expect(keyFingerprint(generateMasterKey())).not.toBe(fp);
    });

    it('prefers FATCAT_MASTER_KEY, then FATCAT_MASTER_KEY_FILE, then master.key', () => {
        const fileKey = encodeMasterKey(Buffer.alloc(32, 2));
        const dataKey = encodeMasterKey(Buffer.alloc(32, 3));
        const files: Record<string, string> = { '/k': fileKey };
        const make = (env: NodeJS.ProcessEnv, data: string | null = dataKey) =>
            createMasterKeyResolver({ env, readDataDirKey: () => data, readFile: (p) => files[p]! }).current();
        expect(make({ FATCAT_MASTER_KEY: hex, FATCAT_MASTER_KEY_FILE: '/k' })).toEqual({
            source: 'env',
            key: Buffer.from(hex, 'hex'),
        });
        expect(make({ FATCAT_MASTER_KEY_FILE: '/k' })).toEqual({ source: 'env-file', key: Buffer.alloc(32, 2) });
        expect(make({})).toEqual({ source: 'data-dir', key: Buffer.alloc(32, 3) });
        expect(make({}, null)).toEqual({ source: 'none', key: null });
    });

    it('does not fall back when the first or second source is malformed or unreadable', () => {
        const dataKey = encodeMasterKey(Buffer.alloc(32, 3));
        const resolver = (env: NodeJS.ProcessEnv) =>
            createMasterKeyResolver({
                env,
                readDataDirKey: () => dataKey,
                readFile: (p) => {
                    if (p === '/missing') throw Object.assign(new Error('x'), { code: 'ENOENT' });
                    return 'not a key at all';
                },
            });
        expect(() => resolver({ FATCAT_MASTER_KEY: 'bad', FATCAT_MASTER_KEY_FILE: '/ok' }).current()).toThrow(
            MasterKeyFormatError,
        );
        expect(() => resolver({ FATCAT_MASTER_KEY_FILE: '/bad' }).current()).toThrow(MasterKeyFormatError);
        expect(() => resolver({ FATCAT_MASTER_KEY_FILE: '/missing' }).current()).toThrow(MasterKeyFormatError);
    });

    it('ensure() creates master.key only when no source exists, and an invalid master.key is never replaced', () => {
        let stored: string | null = null;
        const resolver = createMasterKeyResolver({
            env: {},
            readDataDirKey: () => stored,
            createDataDirKey: (key) => {
                stored = encodeMasterKey(key);
            },
        });
        expect(resolver.current()).toEqual({ source: 'none', key: null });
        const created = resolver.ensure();
        expect(created.source).toBe('data-dir');
        expect(created.key).toHaveLength(32);
        expect(resolver.ensure().key).toEqual(created.key);
        stored = 'garbage';
        expect(resolver.ensure()).toEqual({ source: 'data-dir', key: null });
        expect(stored).toBe('garbage');
    });
});

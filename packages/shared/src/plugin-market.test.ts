// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { PluginPrepareInput } from './plugin-api.js';
import { PluginIndexSignature } from './plugin-market.js';

const sig = `${'A'.repeat(86)}==`;

describe('PluginIndexSignature', () => {
    it('accepts an ed25519 signature with a key id and rejects anything else', () => {
        expect(PluginIndexSignature.safeParse({ keyId: 'fatcat-main-2026', alg: 'ed25519', sig }).success).toBe(true);
        expect(PluginIndexSignature.safeParse({ keyId: 'Main', alg: 'ed25519', sig }).success).toBe(false);
        expect(PluginIndexSignature.safeParse({ keyId: 'k', alg: 'rsa', sig }).success).toBe(false);
        expect(PluginIndexSignature.safeParse({ keyId: 'k', alg: 'ed25519', sig: 'AAAA' }).success).toBe(false);
        expect(PluginIndexSignature.safeParse({ keyId: 'k', alg: 'ed25519', sig, extra: 1 }).success).toBe(false);
    });
});

describe('PluginPrepareInput', () => {
    it('takes a local path or a market id + version, nothing else', () => {
        expect(PluginPrepareInput.safeParse({ source: { kind: 'local', path: '/tmp/x' } }).success).toBe(true);
        expect(
            PluginPrepareInput.safeParse({
                source: { kind: 'market', market: 'official', id: 'weather', version: '1.2.0' },
            }).success,
        ).toBe(true);
        expect(
            PluginPrepareInput.safeParse({ source: { kind: 'market', market: 'official', id: 'weather' } }).success,
        ).toBe(false);
        // 市场来源不能带 URL:下载地址只来自已签名的索引
        expect(
            PluginPrepareInput.safeParse({
                source: {
                    kind: 'market',
                    market: 'official',
                    id: 'weather',
                    version: '1.2.0',
                    url: 'https://x.test/a',
                },
            }).success,
        ).toBe(false);
        expect(PluginPrepareInput.safeParse({ source: { kind: 'git', url: 'https://x.test' } }).success).toBe(false);
    });
});

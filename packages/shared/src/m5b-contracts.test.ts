// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    EgressTarget,
    ItemAskRequest,
    ItemRelatedQuery,
    LoginChallenge,
    RecoveryCode,
    SecretsMigrateRequest,
    SecretsStatus,
    TotpConfirmRequest,
    TotpLoginRequest,
    TotpRecoveryCodes,
} from './index.js';

const PW = 'correct horse battery';

describe('TOTP 请求', () => {
    it('验证码和恢复码恰好给一个', () => {
        const tok = 'a'.repeat(32);
        expect(TotpLoginRequest.safeParse({ challengeToken: tok, code: '123456' }).success).toBe(true);
        expect(TotpLoginRequest.safeParse({ challengeToken: tok, recoveryCode: 'abcde-23456' }).success).toBe(true);
        expect(TotpLoginRequest.safeParse({ challengeToken: tok }).success).toBe(false);
        expect(
            TotpLoginRequest.safeParse({ challengeToken: tok, code: '123456', recoveryCode: 'abcde-23456' }).success,
        ).toBe(false);
        expect(TotpConfirmRequest.safeParse({ password: PW }).success).toBe(false);
        expect(TotpConfirmRequest.safeParse({ password: PW, code: '000000' }).success).toBe(true);
    });

    it('验证码必须是 6 位数字;恢复码用 Crockford Base32 两组 5 位', () => {
        expect(TotpLoginRequest.safeParse({ challengeToken: 'a'.repeat(32), code: '12345' }).success).toBe(false);
        expect(TotpLoginRequest.safeParse({ challengeToken: 'a'.repeat(32), code: '12345a' }).success).toBe(false);
        expect(RecoveryCode.safeParse('ABCDE-23456').success).toBe(true);
        expect(RecoveryCode.safeParse('ABCDI-23456').success).toBe(false); // I 不在字母表里
        expect(RecoveryCode.safeParse('ABCDE23456').success).toBe(false);
    });

    it('恢复码列表恰好 10 个;临时凭证响应固定 totpRequired', () => {
        const one = 'ABCDE-23456';
        expect(TotpRecoveryCodes.safeParse({ recoveryCodes: Array(10).fill(one) }).success).toBe(true);
        expect(TotpRecoveryCodes.safeParse({ recoveryCodes: Array(9).fill(one) }).success).toBe(false);
        const ok = { totpRequired: true, challengeToken: 'x'.repeat(32), expiresAt: '2026-11-13T08:50:00.000Z' };
        expect(LoginChallenge.safeParse(ok).success).toBe(true);
        expect(LoginChallenge.safeParse({ ...ok, totpRequired: false }).success).toBe(false);
    });
});

describe('外连目标', () => {
    const base = {
        id: 'model:1',
        category: 'model',
        label: 'DeepSeek',
        origin: 'https://api.deepseek.com',
        local: false,
        source: { kind: 'model-profile', id: '01JC0000000000000000000000' },
        enabled: true,
    };

    it('origin 只到协议 + 主机 + 端口', () => {
        expect(EgressTarget.safeParse(base).success).toBe(true);
        expect(EgressTarget.safeParse({ ...base, origin: 'http://127.0.0.1:11434' }).success).toBe(true);
        for (const bad of [
            'https://api.deepseek.com/v1',
            'https://api.deepseek.com/?k=1',
            'https://user:pw@api.deepseek.com',
            'api.deepseek.com',
        ]) {
            expect(EgressTarget.safeParse({ ...base, origin: bad }).success, bad).toBe(false);
        }
    });

    it('stdio 类 MCP 为本地进程,origin 为 null;未知类别被拒绝', () => {
        expect(EgressTarget.safeParse({ ...base, category: 'mcp', origin: null, local: true }).success).toBe(true);
        expect(EgressTarget.safeParse({ ...base, category: 'telemetry' }).success).toBe(false);
    });
});

describe('密钥状态与迁移', () => {
    it('指纹是 8 位十六进制,不可用时为 null', () => {
        const s = {
            file: 'encrypted',
            masterKeySource: 'data-dir',
            keyAvailable: true,
            fingerprint: 'a1b2c3d4',
            backups: { total: 5, plaintext: 0 },
        };
        expect(SecretsStatus.safeParse(s).success).toBe(true);
        expect(SecretsStatus.safeParse({ ...s, fingerprint: null, keyAvailable: false }).success).toBe(true);
        expect(SecretsStatus.safeParse({ ...s, fingerprint: 'a1b2c3d4e5' }).success).toBe(false);
    });

    it('迁移必须显式 confirm,默认不动明文备份', () => {
        expect(SecretsMigrateRequest.safeParse({}).success).toBe(false);
        expect(SecretsMigrateRequest.safeParse({ confirm: false }).success).toBe(false);
        expect(SecretsMigrateRequest.parse({ confirm: true }).plaintextBackups).toBe('keep');
    });
});

describe('条目 related 与 ask', () => {
    it('ask 默认 scope 为 item;related 限制 limit', () => {
        expect(ItemAskRequest.safeParse({}).success).toBe(true);
        expect(ItemAskRequest.safeParse({ scope: 'everything' }).success).toBe(false);
        expect(ItemRelatedQuery.safeParse({ limit: '500' }).success).toBe(false);
        expect(ItemRelatedQuery.safeParse({ rel: 'mentions' }).success).toBe(true);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    base32Decode,
    base32Encode,
    generateRecoveryCodes,
    generateTotpSecret,
    hashRecoveryCode,
    hotp,
    otpauthUri,
    recoveryCodeMatches,
    timeStep,
    verifyTotp,
} from './totp.js';

// RFC 6238 附录 B:SHA-1 的共享密钥是 ASCII "12345678901234567890"
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);
const VECTORS: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
];

describe('RFC 6238 appendix B (SHA-1)', () => {
    it.each(VECTORS)('T = %i s gives %s (8 digits) and its last 6 digits', (seconds, eight) => {
        const step = timeStep(seconds * 1000);
        expect(hotp(RFC_SECRET, step, 8)).toBe(eight);
        expect(hotp(RFC_SECRET, step, 6)).toBe(eight.slice(2));
        expect(verifyTotp(RFC_SECRET_B32, eight.slice(2), seconds * 1000)).toBe(step);
    });

    it('accepts one step either side and refuses two', () => {
        const now = 1111111109 * 1000;
        const step = timeStep(now);
        const at = (s: number) => hotp(RFC_SECRET, s, 6);
        expect(verifyTotp(RFC_SECRET_B32, at(step - 1), now)).toBe(step - 1);
        expect(verifyTotp(RFC_SECRET_B32, at(step + 1), now)).toBe(step + 1);
        expect(verifyTotp(RFC_SECRET_B32, at(step - 2), now)).toBeNull();
        expect(verifyTotp(RFC_SECRET_B32, at(step + 2), now)).toBeNull();
        expect(verifyTotp(RFC_SECRET_B32, '12345', now)).toBeNull();
    });
});

describe('Base32 and secrets', () => {
    it('round-trips and matches the RFC 4648 vectors', () => {
        expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
        expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
        const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
        expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
        expect(() => base32Decode('A1')).toThrow();
    });

    it('generates 32-character secrets that differ each time, and an otpauth URI that carries the fixed parameters', () => {
        const a = generateTotpSecret();
        expect(a).toMatch(/^[A-Z2-7]{32}$/);
        expect(generateTotpSecret()).not.toBe(a);
        expect(otpauthUri('own er', a)).toBe(
            `otpauth://totp/FatCat-AI:own%20er?secret=${a}&issuer=FatCat-AI&algorithm=SHA1&digits=6&period=30`,
        );
    });
});

describe('recovery codes', () => {
    it('makes 10 distinct XXXXX-XXXXX codes; the hash depends on the salt and ignores case', () => {
        const codes = generateRecoveryCodes();
        expect(codes).toHaveLength(10);
        expect(new Set(codes).size).toBe(10);
        for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        const code = codes[0]!;
        const h1 = hashRecoveryCode(code, 'aa');
        expect(hashRecoveryCode(code, 'bb')).not.toBe(h1);
        expect(h1).not.toContain(code);
        expect(recoveryCodeMatches(code.toLowerCase(), 'aa', h1)).toBe(true);
        expect(recoveryCodeMatches(codes[1]!, 'aa', h1)).toBe(false);
    });
});

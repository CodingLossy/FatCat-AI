// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// TOTP(RFC 6238)、HOTP(RFC 4226)、Base32 与恢复码(ADR 0027)。只用 node:crypto,不加依赖。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 校验时前后各允许偏移的步长数。 */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32,无填充。 */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

/** 解码 Base32(大小写不敏感,忽略填充);含非法字符抛错。 */
export function base32Decode(text: string): Buffer {
    const clean = text.replace(/=+$/, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const index = BASE32.indexOf(ch);
        if (index < 0) throw new Error('invalid Base32 character');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** 20 字节随机共享密钥,Base32 编码(32 个字符)。 */
export function generateTotpSecret(): string {
    return base32Encode(randomBytes(SECRET_BYTES));
}

/** HOTP(RFC 4226):HMAC-SHA-1 加动态截断;返回补零到 digits 位的字符串。 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const mac = createHmac('sha1', secret).update(message).digest();
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
        ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, '0');
}

/** 时间步长(RFC 6238):T0 = 0,步长 30 秒。 */
export function timeStep(ms: number): number {
    return Math.floor(ms / 1000 / TOTP_PERIOD_SECONDS);
}

function codesEqual(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 校验验证码:检查当前步长及前后各 1 步(共 3 步),全部比较完才返回;匹配时返回该步长,否则 null。
 * 重放保护由调用方负责(步长必须大于 last_used_step)。
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number): number | null {
    const secret = base32Decode(secretBase32);
    const current = timeStep(nowMs);
    let matched: number | null = null;
    for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
        const step = current + delta;
        if (step < 0) continue;
        if (codesEqual(hotp(secret, step), code) && (matched === null || step > matched)) matched = step;
    }
    return matched;
}

export const ISSUER = 'FatCat-AI';

/** otpauth://totp/FatCat-AI:<用户名>?secret=…&issuer=FatCat-AI&algorithm=SHA1&digits=6&period=30 */
export function otpauthUri(username: string, secretBase32: string): string {
    const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(username)}`;
    const query = `secret=${secretBase32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
    return `otpauth://totp/${label}?${query}`;
}

// ---- 恢复码 ----

/** Crockford Base32 字母表(去掉 I、L、O、U)。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 个恢复码,格式 XXXXX-XXXXX。256 能被 32 整除,取低 5 位没有偏差。 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
    return Array.from({ length: count }, () => {
        const bytes = randomBytes(10);
        const chars = Array.from(bytes, (b) => CROCKFORD[b & 31]).join('');
        return `${chars.slice(0, 5)}-${chars.slice(5)}`;
    });
}

/** 比较前统一成大写。 */
export function normalizeRecoveryCode(code: string): string {
    return code.trim().toUpperCase();
}

export function newRecoverySalt(): string {
    return randomBytes(16).toString('hex');
}

/** SHA-256(salt ‖ ":" ‖ 规范化后的恢复码),十六进制。恢复码本身有 50 位熵,每码独立盐已足够。 */
export function hashRecoveryCode(code: string, salt: string): string {
    return createHash('sha256')
        .update(`${salt}:${normalizeRecoveryCode(code)}`, 'utf8')
        .digest('hex');
}

/** 常数时间比较(哈希等长)。 */
export function recoveryCodeMatches(code: string, salt: string, expectedHash: string): boolean {
    return codesEqual(hashRecoveryCode(code, salt), expectedHash);
}

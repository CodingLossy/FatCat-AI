// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

/** 随机令牌:32 字节 base64url(43 个字符)。 */
export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

/** 令牌在库中只存 SHA-256(十六进制)。令牌本身是高熵随机串,无需加盐慢哈希。 */
export function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 常量时间比较,长度不同直接返回 false。 */
export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

/** 个人访问令牌:aip_pat_ 前缀便于识别与密钥扫描。 */
export const PAT_PREFIX = 'aip_pat_';
export function newAccessToken(): string {
    return PAT_PREFIX + randomToken();
}

/** 设备令牌(ADR 0045):access 短期、refresh 长期且每次使用都轮换;前缀便于识别与密钥扫描。 */
export const DEVICE_ACCESS_PREFIX = 'aip_dev_';
export const DEVICE_REFRESH_PREFIX = 'aip_ref_';
export const newDeviceAccessToken = () => DEVICE_ACCESS_PREFIX + randomToken();
export const newDeviceRefreshToken = () => DEVICE_REFRESH_PREFIX + randomToken();

const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 配对码:10 位 Crockford Base32(约 50 位熵),显示为 XXXXX-XXXXX;32 个符号,按位取低 5 位没有取模偏差。 */
export function newPairingCode(): string {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => PAIRING_ALPHABET[b & 31]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
/** 去掉连字符、转大写;库里存的是规范化后的哈希。 */
export const normalizePairingCode = (code: string) => code.replaceAll('-', '').toUpperCase();

// scrypt 参数:N=2^16、r=8、p=1,约占 64MB 内存、在普通机器上约 100ms;登录有限速,2GB 机器可承受。
const SCRYPT = { N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LEN = 32;

/** 密码哈希格式:scrypt$N$r$p$<salt base64url>$<hash base64url>。 */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const expected = Buffer.from(hashB64, 'base64url');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT.maxmem,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 用户名不存在时也做一次同等开销的校验,避免通过响应时间判断用户名是否存在。 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
    dummyHash ??= hashPassword(randomToken());
    return dummyHash;
}

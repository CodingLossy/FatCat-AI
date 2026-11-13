// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 密钥文件的信封加密与主密钥来源(ADR 0026 第 2、3 节)。只用 node:crypto,不加依赖。
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MasterKeySource } from '@fatcat-ai/shared';

export const ENVELOPE_VERSION = 'fcsec1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** 认证失败(密钥不对或文件被改)的统一错误,不区分原因、不回显任何内容。 */
export class SecretsKeyUnavailableError extends Error {
    override readonly name = 'SecretsKeyUnavailableError';
    readonly code = 'secrets_key_unavailable';
    constructor() {
        super('密钥不可用');
    }
}

/** 信封格式不对或版本未知:拒绝读取。 */
export class SecretsEnvelopeError extends Error {
    override readonly name = 'SecretsEnvelopeError';
    readonly code = 'secrets_envelope_invalid';
}

/** 环境变量或其指向的文件里的主密钥格式不对;启动时报错,不回退到下一个来源。 */
export class MasterKeyFormatError extends Error {
    override readonly name = 'MasterKeyFormatError';
    readonly code = 'master_key_invalid';
}

export function generateMasterKey(): Buffer {
    return randomBytes(KEY_BYTES);
}

/** 主密钥的文本形式(master.key 文件内容):64 位十六进制。 */
export function encodeMasterKey(key: Buffer): string {
    return key.toString('hex');
}

/** 接受 64 位十六进制或 base64(标准或 URL 安全,可带或不带填充),解出恰好 32 字节;其他一律拒绝。 */
export function parseMasterKey(text: string, label = 'master key'): Buffer {
    const value = text.trim();
    let key: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
    else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) key = Buffer.from(value.replace(/=$/, ''), 'base64url');
    // 错误信息不含值本身
    if (!key || key.length !== KEY_BYTES) {
        throw new MasterKeyFormatError(`${label} must be 32 bytes, given as 64 hex characters or base64`);
    }
    return key;
}

/** 主密钥的 SHA-256 哈希前 8 位十六进制,供核对;不是密钥本身。 */
export function keyFingerprint(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

const aad = (nonce: Buffer) => Buffer.concat([Buffer.from(ENVELOPE_VERSION, 'utf8'), nonce]);

/** 加密成 `fcsec1:<nonce>:<密文>:<标签>`(各段 base64url);每次调用生成新的随机 nonce。 */
export function encryptSecrets(plaintext: string, key: Buffer): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(nonce));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
        ENVELOPE_VERSION,
        nonce.toString('base64url'),
        body.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
    ].join(':');
}

/** 是否像一个信封(只看前缀,不验证)。 */
export function looksLikeEnvelope(text: string): boolean {
    return /^fcsec\d+:/.test(text.trim());
}

/** 解密。版本未知或格式不对抛 SecretsEnvelopeError;认证失败抛 SecretsKeyUnavailableError。 */
export function decryptSecrets(envelope: string, key: Buffer): string {
    const parts = envelope.trim().split(':');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
        throw new SecretsEnvelopeError('unsupported or malformed secrets envelope');
    }
    const b64 = /^[A-Za-z0-9_-]*$/;
    if (!parts.slice(1).every((p) => b64.test(p)))
        throw new SecretsEnvelopeError('unsupported or malformed secrets envelope');
    const nonce = Buffer.from(parts[1]!, 'base64url');
    const body = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretsEnvelopeError('unsupported or malformed secrets envelope');
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad(nonce));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
        throw new SecretsKeyUnavailableError();
    }
}

/** 常数时间比较两个字符串;长度不同直接为 false。 */
export function constantTimeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

export interface MasterKeyResolution {
    source: MasterKeySource;
    /** null:没有找到主密钥,或数据目录里的 master.key 内容不合法(此时不会覆盖它)。 */
    key: Buffer | null;
}

/** 主密钥的取得方式。current() 不创建任何东西;ensure() 在没有任何来源时才创建 master.key。 */
export interface MasterKeyResolver {
    current(): MasterKeyResolution;
    ensure(): MasterKeyResolution;
}

export interface MasterKeySources {
    env: NodeJS.ProcessEnv;
    /** 读数据目录里的 master.key 文本;不存在返回 null。 */
    readDataDirKey: () => string | null;
    /** 创建 master.key(权限 600)并返回其文本;已存在时不得覆盖。 */
    createDataDirKey?: (key: Buffer) => void;
    /** 测试用:替换读文件。 */
    readFile?: (path: string) => string;
}

/**
 * 按优先级取第一个存在的来源:FATCAT_MASTER_KEY → FATCAT_MASTER_KEY_FILE → 数据目录的 master.key(ADR 0026 第 3 节)。
 * 前两个来源存在但格式不对(或文件读不出)抛 MasterKeyFormatError,不回退到下一个。
 * master.key 内容不合法时返回 { source: 'data-dir', key: null }:服务器照常启动,依赖密钥的功能报「密钥不可用」。
 */
export function createMasterKeyResolver(sources: MasterKeySources): MasterKeyResolver {
    const read = sources.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const current = (): MasterKeyResolution => {
        const direct = sources.env.FATCAT_MASTER_KEY;
        if (direct !== undefined && direct.trim() !== '') {
            return { source: 'env', key: parseMasterKey(direct, 'FATCAT_MASTER_KEY') };
        }
        const file = sources.env.FATCAT_MASTER_KEY_FILE;
        if (file !== undefined && file.trim() !== '') {
            let text: string;
            try {
                text = read(file);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code ?? 'error';
                throw new MasterKeyFormatError(`FATCAT_MASTER_KEY_FILE cannot be read (${code})`);
            }
            return { source: 'env-file', key: parseMasterKey(text, 'The file named by FATCAT_MASTER_KEY_FILE') };
        }
        const text = sources.readDataDirKey();
        if (text === null) return { source: 'none', key: null };
        try {
            return { source: 'data-dir', key: parseMasterKey(text, 'master.key') };
        } catch {
            return { source: 'data-dir', key: null };
        }
    };
    return {
        current,
        ensure() {
            const found = current();
            if (found.source !== 'none') return found;
            if (!sources.createDataDirKey) return found;
            sources.createDataDirKey(generateMasterKey());
            return current();
        },
    };
}

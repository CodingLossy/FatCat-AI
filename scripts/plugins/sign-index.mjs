#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 在业主本机给 index.json 签名(ADR 0040 第 5.2 节):对 index.json 的原始字节做 Ed25519 签名,写出 index.json.sig。
//
//   node scripts/plugins/sign-index.mjs --key <私钥 PKCS#8 PEM 文件> --key-id fatcat-main-2026 [--index index.json] [--out index.json.sig]
//   node scripts/plugins/sign-index.mjs --verify [--index index.json] [--out index.json.sig]   (只用内置公钥核对,可在 CI 里跑)
//
// 约束(业主已定):
// - 私钥只从命令行给出的本地文件路径读取;不读环境变量、不读标准输入、不在 CI 或 GitHub Secrets 里运行
//   (检测到 CI 环境变量时直接拒绝)。
// - 只依赖 node:crypto 与 node:fs,可以单独拷到任何机器上运行。
// - 默认只接受两把官方 keyId(fatcat-main-2026、fatcat-backup-2026),并且私钥推出的公钥必须与内置的那把一致,
//   防止拿错密钥或写错 keyId 签出一份客户端会拒绝的索引。给第三方市场签名时加 --allow-unknown-key-id。
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 packages/tools/src/plugins/market.ts 的 OFFICIAL_MARKET_KEYS 一致(有测试核对)。 */
export const OFFICIAL_PUBLIC_KEYS = {
    'fatcat-main-2026': '2H2fZiXIg7HsosmJFs4Jud0nnPJeyTY+hjMRjGJ1WiA=',
    'fatcat-backup-2026': 'Bpfd95B0tbx/JYLGhQ9CMDbdQwdYwbiGzJQFuaEK0zk=',
};

const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class SignError extends Error {}

function rawPublicKey(publicKey) {
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

/**
 * 签名并返回 { signature(JSON 文本), keyId, serial, publicKey(base64), indexSha256 }。
 * `keyPem` 是私钥文件的内容(调用方只能从文件读取)。
 */
export function signIndexBytes({ indexBytes, keyPem, keyId, allowUnknownKeyId = false, now = new Date() }) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(keyId)) throw new SignError(`keyId "${keyId}" is not valid`);
    if (indexBytes.length > INDEX_MAX_BYTES) throw new SignError('index.json is larger than 4 MiB');
    let index;
    try {
        index = JSON.parse(indexBytes.toString('utf8'));
    } catch {
        throw new SignError('index.json is not valid JSON');
    }
    if (index === null || typeof index !== 'object' || index.formatVersion !== 1) {
        throw new SignError('index.json: formatVersion must be 1');
    }
    if (!Number.isInteger(index.serial) || index.serial < 0)
        throw new SignError('index.json: serial must be an integer');
    const expires = Date.parse(index.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime()) {
        throw new SignError('index.json: expiresAt is missing or already in the past; clients would reject this index');
    }

    let privateKey;
    try {
        privateKey = createPrivateKey({ key: keyPem, format: 'pem' });
    } catch {
        throw new SignError('the key file is not a PEM private key (expected PKCS#8)');
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new SignError('the key must be an Ed25519 private key');
    const publicKey = createPublicKey(privateKey);
    const raw = rawPublicKey(publicKey).toString('base64');
    const known = OFFICIAL_PUBLIC_KEYS[keyId];
    if (known === undefined && !allowUnknownKeyId) {
        throw new SignError(
            `keyId "${keyId}" is not one of the official keys (${Object.keys(OFFICIAL_PUBLIC_KEYS).join(', ')}); ` +
                'pass --allow-unknown-key-id when signing for another market',
        );
    }
    if (known !== undefined && known !== raw) {
        throw new SignError(
            `this private key does not belong to ${keyId}: its public key is ${raw}, expected ${known}`,
        );
    }

    const signature = sign(null, indexBytes, privateKey);
    if (!verify(null, indexBytes, publicKey, signature))
        throw new SignError('self-check failed: the signature does not verify');
    return {
        signature: `${JSON.stringify({ keyId, alg: 'ed25519', sig: signature.toString('base64') })}\n`,
        keyId,
        serial: index.serial,
        publicKey: raw,
    };
}

/** 供测试与其他脚本校验:用原始公钥验证 index.json 与 .sig 文本。 */
export function verifySignature(indexBytes, signatureText, rawPublicKeyBase64) {
    const { sig } = JSON.parse(signatureText);
    const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPublicKeyBase64, 'base64')]),
        format: 'der',
        type: 'spki',
    });
    return verify(null, indexBytes, key, Buffer.from(sig, 'base64'));
}

/** 用内置的官方公钥验证 index.json 与 index.json.sig(不需要私钥,可以在 CI 里运行)。返回签名用的 keyId。 */
export function verifyOfficial(indexBytes, signatureText) {
    let parsed;
    try {
        parsed = JSON.parse(signatureText);
    } catch {
        throw new SignError('index.json.sig is not valid JSON');
    }
    const publicKey = OFFICIAL_PUBLIC_KEYS[parsed?.keyId];
    if (publicKey === undefined) throw new SignError(`index.json.sig names an unknown keyId: ${parsed?.keyId}`);
    if (parsed.alg !== 'ed25519' || typeof parsed.sig !== 'string')
        throw new SignError('index.json.sig has the wrong format');
    if (!verifySignature(indexBytes, signatureText, publicKey)) {
        throw new SignError('the signature does not match index.json (was index.json edited after signing?)');
    }
    return parsed.keyId;
}

function parseArgs(argv) {
    const out = { allowUnknownKeyId: false, verify: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--allow-unknown-key-id') out.allowUnknownKeyId = true;
        else if (arg === '--verify') out.verify = true;
        else if (['--key', '--key-id', '--index', '--out'].includes(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new SignError(`${arg} needs a value`);
            out[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
        } else throw new SignError(`unknown argument: ${arg}`);
    }
    return out;
}

export function main(argv, env = process.env) {
    if (env.CI || env.GITHUB_ACTIONS) {
        throw new SignError('refusing to run in CI: signing keys must never be available to CI or GitHub Secrets');
    }
    const args = parseArgs(argv);
    if (args.verify) {
        // 只用公钥核对已发布的一对文件,不需要也不接受私钥
        const indexPath = resolve(args.index ?? 'index.json');
        const keyId = verifyOfficial(
            readFileSync(indexPath),
            readFileSync(resolve(args.out ?? `${indexPath}.sig`), 'utf8'),
        );
        console.log(`signature OK (${keyId})`);
        return;
    }
    if (!args.key)
        throw new SignError(
            'usage: sign-index.mjs --key <private-key.pem> --key-id <id> [--index index.json] [--out index.json.sig]',
        );
    if (!args.keyId) throw new SignError('--key-id is required (fatcat-main-2026 or fatcat-backup-2026)');
    const keyPath = resolve(args.key);
    // Open once and check the same descriptor, so the file cannot change between the check and the read.
    let keyPem;
    let keyMode;
    try {
        const fd = openSync(keyPath, 'r');
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) throw new SignError(`key file not found: ${keyPath}`);
            keyMode = stat.mode;
            keyPem = readFileSync(fd);
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        if (error instanceof SignError) throw error;
        throw new SignError(`key file not found: ${keyPath}`);
    }
    if (process.platform !== 'win32' && (keyMode & 0o077) !== 0) {
        console.warn(`warning: ${keyPath} is readable by other users; run chmod 600 on it`);
    }
    const indexPath = resolve(args.index ?? 'index.json');
    const outPath = resolve(args.out ?? `${indexPath}.sig`);
    const result = signIndexBytes({
        indexBytes: readFileSync(indexPath),
        keyPem,
        keyId: args.keyId,
        allowUnknownKeyId: args.allowUnknownKeyId,
    });
    writeFileSync(outPath, result.signature);
    console.log(`signed ${indexPath} (serial ${result.serial}) with ${result.keyId}`);
    console.log(`public key ${result.publicKey}`);
    console.log(`wrote ${outPath}`);
    console.log('Publish index.json and index.json.sig together; never commit or upload the private key.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof SignError ? `error: ${error.message}` : error);
        process.exit(1);
    }
}

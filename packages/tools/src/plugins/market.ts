// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件市场的验证与下载(ADR 0040 第 5.2、5.3 节):Ed25519 验签(node:crypto,不引入依赖)、索引与包的下载
// (只 https、主机必须在允许列表里、每一跳重定向都检查、解析出的地址过 net-guard 并受 fake-IP 开关约束)、
// 包的大小与 sha256 检查。校验和与签名只证明「下载的就是审核时的那个包」,不证明审核者批准的包没有恶意。
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
    PLUGIN_PACKAGE_MAX_BYTES,
    PluginIndex,
    PluginIndexSignature,
    type PluginIndexVersion,
} from '@fatcat-ai/shared';
import { guardedFetch, WebFetchError, type WebFetchOptions } from '../builtin/web-fetch.js';
import { isBlockedAddress, isFakeIpAddress } from '../builtin/net-guard.js';

export const INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 1024;
export const INDEX_TIMEOUT_MS = 30_000;
export const PACKAGE_TIMEOUT_MS = 120_000;

/** 稳定的原因码:索引类写进 `market-rejected` 事件与市场状态,包类就是 API 的错误码。 */
export type MarketErrorCode =
    | 'index_download_failed'
    | 'index_signature_invalid'
    | 'index_unknown_key'
    | 'index_invalid'
    | 'index_wrong_market'
    | 'index_rollback'
    | 'index_expired'
    | 'plugin_download_failed'
    | 'plugin_too_large'
    | 'plugin_checksum_mismatch';

export class MarketError extends Error {
    override readonly name = 'MarketError';
    constructor(
        readonly code: MarketErrorCode,
        message: string,
    ) {
        super(message);
    }
}

/** 一把市场公钥:`publicKey` 是原始 32 字节 Ed25519 公钥的 base64。 */
export interface MarketKey {
    keyId: string;
    publicKey: string;
}

export interface MarketConfig {
    id: string;
    indexUrl: string;
    keys: readonly MarketKey[];
    /** 内置的官方市场。 */
    official: boolean;
    /** 取索引时除了 indexUrl 的主机之外还允许的主机(重定向用);默认没有。 */
    indexHosts?: readonly string[];
}

export const OFFICIAL_MARKET_ID = 'official';
/** 官方索引(GitHub Pages 直接提供,不经重定向);索引仓库 CodingLossy/fatcat-plugins 由业主维护。 */
export const OFFICIAL_INDEX_URL = 'https://codinglossy.github.io/fatcat-plugins/index.json';

/**
 * 两把官方公钥(主用与备用,业主 2026-11-18 生成),两把签的索引都接受。主用私钥泄露或丢失时改用备用签名,
 * 并在下一个版本里换掉泄露的公钥。私钥只在业主本机,绝不进仓库、CI 或 GitHub Secrets。
 */
export const OFFICIAL_MARKET_KEYS: readonly MarketKey[] = [
    { keyId: 'fatcat-main-2026', publicKey: '2H2fZiXIg7HsosmJFs4Jud0nnPJeyTY+hjMRjGJ1WiA=' },
    { keyId: 'fatcat-backup-2026', publicKey: 'Bpfd95B0tbx/JYLGhQ9CMDbdQwdYwbiGzJQFuaEK0zk=' },
];

export function officialMarket(indexUrl: string = OFFICIAL_INDEX_URL): MarketConfig {
    return { id: OFFICIAL_MARKET_ID, indexUrl, keys: OFFICIAL_MARKET_KEYS, official: true };
}

// Ed25519 公钥的 SPKI 前缀 + 32 字节原始公钥
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(base64: string): KeyObject {
    const raw = Buffer.from(base64, 'base64');
    if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export interface VerifiedIndex {
    index: PluginIndex;
    keyId: string;
}

/**
 * 验证 `index.json` 的原始字节:签名文件格式正确、keyId 已知、签名对原始字节有效,然后才解析与校验 schema。
 * 顺序固定:先验签再解析,不信任的内容不进 JSON 解析器。
 */
export function verifyIndex(
    indexBytes: Uint8Array,
    signatureBytes: Uint8Array,
    keys: readonly MarketKey[],
    marketId: string,
): VerifiedIndex {
    if (indexBytes.byteLength > INDEX_MAX_BYTES)
        throw new MarketError('index_invalid', 'the index is larger than 4 MiB');
    if (signatureBytes.byteLength > SIGNATURE_MAX_BYTES) {
        throw new MarketError('index_signature_invalid', 'the signature file is too large');
    }
    let signature: PluginIndexSignature;
    try {
        const parsed = PluginIndexSignature.safeParse(JSON.parse(Buffer.from(signatureBytes).toString('utf8')));
        if (!parsed.success) throw new Error('bad format');
        signature = parsed.data;
    } catch {
        throw new MarketError('index_signature_invalid', 'the signature file is not in the expected format');
    }
    const key = keys.find((k) => k.keyId === signature.keyId);
    if (!key)
        throw new MarketError('index_unknown_key', `the index is signed with an unknown key (${signature.keyId})`);
    let valid: boolean;
    try {
        valid = verify(null, indexBytes, publicKeyFromRaw(key.publicKey), Buffer.from(signature.sig, 'base64'));
    } catch {
        valid = false;
    }
    if (!valid) throw new MarketError('index_signature_invalid', 'the signature does not match the index');
    let parsed;
    try {
        parsed = PluginIndex.safeParse(JSON.parse(Buffer.from(indexBytes).toString('utf8')));
    } catch {
        throw new MarketError('index_invalid', 'the index is not valid JSON');
    }
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new MarketError(
            'index_invalid',
            `the index does not match the format: ${first?.path.join('.')} ${first?.message}`,
        );
    }
    if (parsed.data.market !== marketId) {
        throw new MarketError(
            'index_wrong_market',
            `the index is for market "${parsed.data.market}", not "${marketId}"`,
        );
    }
    return { index: parsed.data, keyId: key.keyId };
}

/** 重定向(或第一跳)的主机不在允许列表里。 */
class HostNotAllowedError extends Error {
    override readonly name = 'HostNotAllowedError';
}

export interface FetchLimitedOptions {
    allowedHosts: readonly string[];
    maxBytes: number;
    timeoutMs: number;
    /** 设置里的「允许 fake-IP 段」。 */
    allowFakeIp?: boolean;
    resolve?: WebFetchOptions['resolve'];
    isBlocked?: WebFetchOptions['isBlocked'];
}

export interface Fetched {
    status: number;
    body: Buffer;
    /** 响应超过 maxBytes(body 已被截断)。 */
    truncated: boolean;
}

/** 只 https、主机在允许列表里、每一跳都检查;不带 Cookie 或任何标识,只发一个 GET。 */
export async function fetchLimited(url: string, options: FetchLimitedOptions): Promise<Fetched> {
    const base = options.isBlocked ?? isBlockedAddress;
    const allowed = options.allowedHosts.map((host) => host.toLowerCase());
    const result = await guardedFetch(url, {
        ...(options.resolve ? { resolve: options.resolve } : {}),
        isBlocked: options.allowFakeIp ? (address) => !isFakeIpAddress(address) && base(address) : base,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        onUrl: (next) => {
            if (next.protocol !== 'https:') throw new WebFetchError('only https: URLs are allowed', 'bad_scheme');
            if (!allowed.includes(next.hostname.toLowerCase())) {
                throw new HostNotAllowedError(`${next.hostname} is not an allowed download host`);
            }
        },
    });
    return { status: result.status, body: result.body, truncated: result.truncated };
}

function describeFetchError(error: unknown): string {
    if (error instanceof WebFetchError || error instanceof HostNotAllowedError) return error.message;
    return error instanceof Error ? error.message : 'request failed';
}

/** 下载 index.json 与 index.json.sig。 */
export async function fetchIndexFiles(
    market: MarketConfig,
    options: Pick<FetchLimitedOptions, 'allowFakeIp' | 'resolve' | 'isBlocked'>,
): Promise<{ index: Buffer; signature: Buffer }> {
    const allowedHosts = [new URL(market.indexUrl).hostname, ...(market.indexHosts ?? [])];
    const get = async (url: string, maxBytes: number): Promise<Buffer> => {
        let fetched: Fetched;
        try {
            fetched = await fetchLimited(url, { ...options, allowedHosts, maxBytes, timeoutMs: INDEX_TIMEOUT_MS });
        } catch (error) {
            throw new MarketError('index_download_failed', describeFetchError(error));
        }
        if (fetched.status !== 200) {
            throw new MarketError('index_download_failed', `the server answered HTTP ${fetched.status}`);
        }
        if (fetched.truncated) throw new MarketError('index_invalid', 'the file is larger than its limit');
        return fetched.body;
    };
    const index = await get(market.indexUrl, INDEX_MAX_BYTES);
    const signature = await get(`${market.indexUrl}.sig`, SIGNATURE_MAX_BYTES);
    return { index, signature };
}

/**
 * 下载一个版本的包并核对大小与 sha256。包的 URL、大小和哈希只来自已签名的索引;
 * 主机必须在该索引的 `downloadHosts` 中。失败不留任何文件(内存里的 Buffer 随引用释放)。
 */
export async function downloadPackage(
    version: Pick<PluginIndexVersion, 'url' | 'size' | 'sha256'>,
    downloadHosts: readonly string[],
    options: Pick<FetchLimitedOptions, 'allowFakeIp' | 'resolve' | 'isBlocked'>,
): Promise<Buffer> {
    const limit = Math.min(version.size, PLUGIN_PACKAGE_MAX_BYTES);
    let fetched: Fetched;
    try {
        fetched = await fetchLimited(version.url, {
            ...options,
            allowedHosts: downloadHosts,
            // 多读一个字节:超过声明的大小就能发现(被截断),不用把整个响应读完
            maxBytes: limit + 1,
            timeoutMs: PACKAGE_TIMEOUT_MS,
        });
    } catch (error) {
        throw new MarketError('plugin_download_failed', describeFetchError(error));
    }
    if (fetched.status !== 200) {
        throw new MarketError('plugin_download_failed', `the server answered HTTP ${fetched.status}`);
    }
    if (fetched.truncated || fetched.body.length > limit) {
        throw new MarketError('plugin_too_large', `the package is larger than the declared ${version.size} bytes`);
    }
    const digest = createHash('sha256').update(fetched.body).digest('hex');
    if (fetched.body.length !== version.size || digest !== version.sha256) {
        throw new MarketError(
            'plugin_checksum_mismatch',
            'the downloaded package does not match the checksum in the signed index',
        );
    }
    return fetched.body;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// fatcat/net.fetch(ADR 0040 第 3.3 节):插件经主程序代发的网络请求。域名范围(matchesDomain)与现有 SSRF 防护
// (checkUrl + 解析出的每个 IP)两者取交集;只允许 https:;重定向每一跳重新检查范围;超时 30 秒、响应体 2 MiB;
// 不带 Cookie,不转发主程序的任何凭据(请求头黑名单在 NetFetchParams 里)。
import { matchesDomain, NetFetchParams, type NetFetchResult } from '@fatcat-ai/shared';
import { guardedFetch, WebFetchError, type WebFetchOptions } from '../builtin/web-fetch.js';
import { isBlockedAddress, isFakeIpAddress } from '../builtin/net-guard.js';

export const NET_FETCH_TIMEOUT_MS = 30_000;
export const NET_FETCH_MAX_BYTES = 2 * 1024 * 1024;

const TEXT_TYPE = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|javascript)\b)/i;

/** 请求(或重定向)的目的地不在授权的域名范围内。运行时据此记 denied 事件。 */
export class NetScopeError extends Error {
    override readonly name = 'NetScopeError';
}

export interface PluginNetFetchOptions {
    /** 该插件已授权的域名(`granted_json.net`)。 */
    domains: readonly string[];
    allowFakeIp?: boolean;
    resolve?: WebFetchOptions['resolve'];
    isBlocked?: WebFetchOptions['isBlocked'];
    timeoutMs?: number;
    maxBytes?: number;
}

export async function pluginNetFetch(input: unknown, options: PluginNetFetchOptions): Promise<NetFetchResult> {
    const params = NetFetchParams.parse(input);
    const base = options.isBlocked ?? isBlockedAddress;
    const result = await guardedFetch(params.url, {
        ...(options.resolve ? { resolve: options.resolve } : {}),
        isBlocked: options.allowFakeIp ? (address) => !isFakeIpAddress(address) && base(address) : base,
        timeoutMs: options.timeoutMs ?? NET_FETCH_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? NET_FETCH_MAX_BYTES,
        method: params.method,
        requestHeaders: params.headers ?? {},
        ...(params.body !== undefined ? { requestBody: params.body } : {}),
        onUrl: (url) => {
            if (url.protocol !== 'https:') throw new WebFetchError('only https: URLs are allowed', 'bad_scheme');
            if (!options.domains.some((domain) => matchesDomain(url.hostname, domain))) {
                throw new NetScopeError(`${url.hostname} is not in the granted domains`);
            }
        },
    });
    const text = TEXT_TYPE.test(result.contentType) || result.contentType === '';
    return {
        status: result.status,
        headers: result.headers,
        body: text ? result.body.toString('utf8') : result.body.toString('base64'),
        bodyEncoding: text ? 'utf8' : 'base64',
        truncated: result.truncated,
    };
}

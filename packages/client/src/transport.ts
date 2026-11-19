// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { FatCatApiError, FatCatNetworkError, errorFromResponse } from './errors.js';

export interface TransportOptions {
    /** 服务器根地址,如 http://127.0.0.1:8787(不含 /api/v1)。 */
    baseUrl: string;
    /** 个人访问令牌 aip_pat_…;不给时按浏览器方式使用 Cookie。 */
    token?: string | (() => string | undefined) | undefined;
    /**
     * 令牌过期(401)时调用,返回 true 表示已换到新令牌,请求会用新令牌重试一次。
     * 并发的 401 共用同一次刷新。只在使用令牌鉴权时有效。
     */
    refreshToken?: ((staleToken: string) => Promise<boolean>) | undefined;
    /** Cookie 鉴权时修改类请求要带的 CSRF 令牌。 */
    csrfToken?: string | (() => string | null | undefined) | undefined;
    fetch?: typeof fetch | undefined;
}

export interface RequestOptions {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string>;
    signal?: AbortSignal | undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class Transport {
    readonly baseUrl: string;
    private readonly tokenSource: TransportOptions['token'];
    private readonly refresher: TransportOptions['refreshToken'];
    private refreshing: Promise<boolean> | null = null;
    private readonly csrf: TransportOptions['csrfToken'];
    private readonly fetchImpl: typeof fetch;

    constructor(options: TransportOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.tokenSource = options.token;
        this.refresher = options.refreshToken;
        this.csrf = options.csrfToken;
        // 绑定 globalThis,避免浏览器里 "Illegal invocation"
        this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    }

    /** 当前令牌(可能随刷新变化);Cookie 鉴权时为 undefined。 */
    get token(): string | undefined {
        const source = this.tokenSource;
        return (typeof source === 'function' ? source() : source) || undefined;
    }

    url(path: string, query?: RequestOptions['query']): string {
        const url = new URL(`${this.baseUrl}/api/v1${path}`);
        for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
        return url.toString();
    }

    headers(method: string, extra: Record<string, string> = {}): Record<string, string> {
        const headers: Record<string, string> = { accept: 'application/json', ...extra };
        if (this.token) {
            headers.authorization = `Bearer ${this.token}`;
        } else if (!SAFE_METHODS.has(method)) {
            const csrf = typeof this.csrf === 'function' ? this.csrf() : this.csrf;
            if (csrf) headers['x-csrf-token'] = csrf;
        }
        return headers;
    }

    /** 发出请求;非 2xx 抛 FatCatApiError,网络失败抛 FatCatNetworkError。 */
    async raw(path: string, options: RequestOptions = {}): Promise<Response> {
        const usedToken = this.token;
        try {
            return await this.send(path, options);
        } catch (error) {
            if (!usedToken || !this.refresher || !isUnauthorized(error) || options.signal?.aborted) throw error;
            if (!(await this.refreshOnce(usedToken))) throw error;
            return this.send(path, options);
        }
    }

    private refreshOnce(staleToken: string): Promise<boolean> {
        // 别的请求已经刷新过了,直接重试
        if (this.token !== staleToken) return Promise.resolve(true);
        this.refreshing ??= this.refresher!(staleToken)
            .catch(() => false)
            .finally(() => {
                this.refreshing = null;
            });
        return this.refreshing;
    }

    private async send(path: string, options: RequestOptions): Promise<Response> {
        const method = options.method ?? 'GET';
        const extra: Record<string, string> = { ...options.headers };
        let body: string | FormData | undefined;
        if (options.body instanceof FormData) {
            // multipart:由 fetch 自己加带 boundary 的 content-type
            body = options.body;
        } else if (options.body !== undefined) {
            extra['content-type'] = 'application/json';
            body = JSON.stringify(options.body);
        }
        let res: Response;
        try {
            res = await this.fetchImpl(this.url(path, options.query), {
                method,
                headers: this.headers(method, extra),
                ...(body !== undefined ? { body } : {}),
                ...(this.token ? {} : { credentials: 'include' as const }),
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } catch (error) {
            if (options.signal?.aborted) throw error;
            throw new FatCatNetworkError(`Cannot reach ${this.baseUrl}`, { cause: error });
        }
        if (!res.ok) throw await errorFromResponse(res);
        return res;
    }

    async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const res = await this.raw(path, options);
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }
}

function isUnauthorized(error: unknown): boolean {
    return error instanceof FatCatApiError && error.problem.status === 401;
}

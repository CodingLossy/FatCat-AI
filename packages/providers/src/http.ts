// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 三种适配器共用的 HTTP 细节:SSE 解析、一次退避重试、错误分类与脱敏、中断与首包超时、连接测试框架(ADR 0006)。
import type { ModelTestResult, ProviderErrorCode } from '@ai-personal/shared';
import { type Redactor, sanitizeUpstreamText } from './redact.js';
import { type ChatChunk, type ChatRequest, ProviderError } from './types.js';

/** 429 与 5xx(含 Anthropic 的 529 overloaded)在收到任何数据前重试一次。 */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRY_WAIT_MS = 10_000;

export function classifyStatus(status: number): ProviderErrorCode {
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status === 408) return 'timeout';
    if (status >= 400 && status < 500) return 'bad_request';
    return 'upstream_error';
}

/** 按 SSE 规则把字节流切成 data 负载;忽略注释、event 与其他字段。 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    const reader = body.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.search(/\r?\n/)) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
                if (line === '') {
                    if (data.length > 0) yield data.join('\n');
                    data = [];
                } else if (line.startsWith('data:')) {
                    data.push(line.slice(5).replace(/^ /, ''));
                }
            }
            if (done) {
                if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
                if (data.length > 0) yield data.join('\n');
                return;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/** 解析一条 SSE data;解析失败视为上游错误。 */
export function parseData<T>(data: string): T {
    try {
        return JSON.parse(data) as T;
    } catch {
        throw new ProviderError('upstream_error', 'upstream sent malformed stream data');
    }
}

export interface HttpOptions {
    redactor: Redactor;
    fetch?: typeof fetch | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    /** 按响应正文细化错误分类(例如 Gemini 对无效密钥返回 400)。 */
    classify?: ((status: number, body: string) => ProviderErrorCode | undefined) | undefined;
}

export function createHttp(options: HttpOptions) {
    const { redactor } = options;
    const doFetch = options.fetch ?? globalThis.fetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    async function errorFrom(res: Response): Promise<ProviderError> {
        let text = '';
        try {
            text = await res.text();
        } catch {
            // 忽略读取失败
        }
        const detail = sanitizeUpstreamText(redactor, text);
        return new ProviderError(
            options.classify?.(res.status, text) ?? classifyStatus(res.status),
            `upstream returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
            res.status,
        );
    }

    function networkError(error: unknown): ProviderError {
        const message = error instanceof Error ? error.message : String(error);
        return new ProviderError('network_error', `request failed: ${sanitizeUpstreamText(redactor, message)}`);
    }

    /** POST JSON;只在尚未收到任何响应数据时,对连接错误与 429 / 5xx 退避重试一次。 */
    async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
            } catch (error) {
                if (signal.aborted) throw error;
                if (attempt === 0) {
                    await sleep(1000);
                    continue;
                }
                throw networkError(error);
            }
            if (res.ok) return res;
            if (attempt === 0 && RETRY_STATUSES.has(res.status)) {
                const retryAfter = Number(res.headers.get('retry-after'));
                await res.body?.cancel().catch(() => undefined);
                await sleep(
                    Number.isFinite(retryAfter) && retryAfter > 0
                        ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS)
                        : 1000,
                );
                continue;
            }
            throw await errorFrom(res);
        }
    }

    return { fetch: doFetch, post, errorFrom, networkError };
}

export type Http = ReturnType<typeof createHttp>;

/**
 * 流式请求的公共外壳:用户中断时产出 finish { reason: 'aborted' } 而不抛错;首个数据块超时报 timeout;
 * 其他非 ProviderError 一律当作网络错误(已脱敏)。body 收到第一块数据后调用 gotData() 清除首包计时。
 */
export async function* guardedStream(
    request: ChatRequest,
    http: Http,
    firstTokenTimeoutMs: number,
    body: (signal: AbortSignal, gotData: () => void) => AsyncGenerator<ChatChunk>,
): AsyncGenerator<ChatChunk> {
    const userSignal = request.signal;
    if (userSignal?.aborted) {
        yield { type: 'finish', reason: 'aborted' };
        return;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(userSignal?.reason);
    userSignal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('first token timeout'));
    }, firstTokenTimeoutMs);
    const clearTimer = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    try {
        yield* body(controller.signal, clearTimer);
    } catch (error) {
        if (userSignal?.aborted) {
            yield { type: 'finish', reason: 'aborted' };
            return;
        }
        if (timedOut) throw new ProviderError('timeout', `no response within ${firstTokenTimeoutMs} ms`);
        if (error instanceof ProviderError) throw error;
        throw http.networkError(error);
    } finally {
        clearTimer();
        userSignal?.removeEventListener('abort', onAbort);
    }
}

export interface TestOptions {
    apiKeyRef: string | null;
    getApiKey: () => string | null;
    timeoutMs: number;
    now: () => number;
}

/** 连接测试外壳:缺密钥直接返回 key_missing;超时与网络错误都转换为结果,从不抛出。 */
export async function runConnectionTest(
    http: Http,
    options: TestOptions,
    signal: AbortSignal | undefined,
    probe: (signal: AbortSignal) => Promise<ModelTestResult>,
): Promise<ModelTestResult> {
    if (options.apiKeyRef !== null && options.getApiKey() === null) {
        return { ok: false, error: 'key_missing', message: `the key referenced by ${options.apiKeyRef} is not set` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        return await probe(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) return { ok: false, error: 'timeout', message: 'connection test timed out' };
        if (error instanceof ProviderError) return { ok: false, error: error.code, message: error.message };
        return { ok: false, error: 'network_error', message: http.networkError(error).message };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** 列出模型的 GET 请求;成功时返回模型 id(最多 100 个)。 */
export async function listModels(
    http: Http,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    started: number,
    now: () => number,
    pick: (json: unknown) => unknown[],
): Promise<ModelTestResult> {
    const res = await http.fetch(url, { headers, signal });
    if (!res.ok) {
        const err = await http.errorFrom(res);
        return { ok: false, error: err.code, message: err.message };
    }
    const json = (await res.json().catch(() => null)) as unknown;
    const models = pick(json)
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 100);
    return { ok: true, latencyMs: now() - started, models };
}

/** 工具名在 OpenAI / Anthropic / Gemini 中都只允许 [A-Za-z0-9_-];我们的工具名带点号(如 memory.save)。 */
export function toWireToolName(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, '__').slice(0, 64);
}

/** 解析工具参数 JSON;空串视为 {}。 */
export function parseToolArgs(args: string, label: string): unknown {
    if (args.trim() === '') return {};
    try {
        return JSON.parse(args) as unknown;
    } catch {
        throw new ProviderError('upstream_error', `tool call ${label} has invalid JSON arguments`);
    }
}

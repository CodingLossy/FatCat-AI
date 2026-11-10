// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// HTTP 录制回放(计划第 11 节):首次对真实端点录制成 fixture,CI 中只回放,保证确定性。
// fixture 落盘前一律脱敏并去掉请求头,不保存任何密钥(ADR 0006 第 3 节)。
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export const Interaction = z.object({
    request: z.object({
        method: z.string(),
        /** 不含协议、主机与端口,回放时只比较路径。 */
        path: z.string(),
        body: z.unknown().optional(),
    }),
    response: z.object({
        status: z.number().int(),
        headers: z.record(z.string(), z.string()).default({}),
        /** 响应体分块;流式响应按 SSE 事件分块,回放时逐块发送。 */
        chunks: z.array(z.string()),
    }),
});
export type Interaction = z.infer<typeof Interaction>;

export const Fixture = z.object({
    name: z.string(),
    /** true 表示按协议手写的合成数据,尚未对真实端点录制。 */
    synthetic: z.boolean().default(false),
    recordedAt: z.string().optional(),
    interactions: z.array(Interaction).min(1),
});
export type Fixture = z.infer<typeof Fixture>;

export function loadFixture(path: string): Fixture {
    return Fixture.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** 保留的响应头;其余(含 set-cookie、各类 id)不落盘。 */
const KEEP_HEADERS = new Set(['content-type', 'retry-after']);

function pathOf(url: string): string {
    const u = new URL(url);
    return u.pathname + u.search;
}

function requestBody(init?: RequestInit): unknown {
    if (typeof init?.body !== 'string') return undefined;
    try {
        return JSON.parse(init.body) as unknown;
    } catch {
        return init.body;
    }
}

/**
 * 回放:按顺序逐个返回 fixture 中的交互;方法或路径对不上时抛错,便于发现请求形态的变化。
 * 返回的 calls 记录了实际收到的请求(含请求体),测试可以对它断言。
 */
export function createReplayFetch(fixture: Fixture) {
    let index = 0;
    const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
    const replayFetch: typeof fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = pathOf(url);
        calls.push({ method, path, body: requestBody(init), headers: new Headers(init?.headers) });
        const next = fixture.interactions[index++];
        if (!next)
            return Promise.reject(new Error(`fixture "${fixture.name}" has no more interactions (${method} ${path})`));
        if (next.request.method.toUpperCase() !== method || next.request.path !== path) {
            return Promise.reject(
                new Error(
                    `fixture "${fixture.name}" expected ${next.request.method} ${next.request.path}, got ${method} ${path}`,
                ),
            );
        }
        const signal = init?.signal;
        if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
        const encoder = new TextEncoder();
        const chunks = [...next.response.chunks];
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (signal?.aborted) {
                    controller.error(signal.reason ?? new Error('aborted'));
                    return;
                }
                const chunk = chunks.shift();
                if (chunk === undefined) controller.close();
                else controller.enqueue(encoder.encode(chunk));
            },
        });
        return Promise.resolve(new Response(body, { status: next.response.status, headers: next.response.headers }));
    };
    return { fetch: replayFetch, calls, remaining: () => fixture.interactions.length - index };
}

export interface RecordOptions {
    name: string;
    /** 落盘前对所有字符串做脱敏(通常是 providers 的 Redactor)。 */
    redact: (text: string) => string;
    realFetch?: typeof fetch;
}

/** 录制:透传到真实端点,同时把请求与完整响应(按 SSE 事件分块)记下来。 */
export function createRecordingFetch(options: RecordOptions) {
    const realFetch = options.realFetch ?? globalThis.fetch;
    const interactions: Interaction[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const res = await realFetch(input, init);
        const text = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
            if (KEEP_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
        });
        const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
        const chunks = isSse ? text.split(/(?<=\n\n)/) : [text];
        const body = requestBody(init);
        interactions.push({
            request: {
                method: (init?.method ?? 'GET').toUpperCase(),
                path: pathOf(url),
                ...(body === undefined ? {} : { body }),
            },
            response: { status: res.status, headers, chunks },
        });
        return new Response(text, { status: res.status, headers: res.headers });
    };
    return {
        fetch: recordingFetch,
        /** 生成脱敏后的 fixture;整个 JSON 文本再过一遍脱敏,防止密钥藏在任意字段里。 */
        fixture(): Fixture {
            const raw: Fixture = {
                name: options.name,
                synthetic: false,
                recordedAt: new Date().toISOString(),
                interactions,
            };
            return Fixture.parse(JSON.parse(options.redact(JSON.stringify(raw))));
        },
        save(path: string): void {
            writeFileSync(path, `${JSON.stringify(this.fixture(), null, 2)}\n`);
        },
    };
}

/**
 * 测试入口:默认回放 fixture;设置 FATCAT_AI_EVAL_LIVE=1 时改为对真实端点录制并覆盖 fixture。
 */
export function fixtureFetch(path: string, live?: { redact: (text: string) => string }) {
    if (process.env.FATCAT_AI_EVAL_LIVE === '1' && live) {
        const name = loadFixture(path).name;
        const rec = createRecordingFetch({ name, redact: live.redact });
        return { fetch: rec.fetch, done: () => rec.save(path), live: true as const };
    }
    const replay = createReplayFetch(loadFixture(path));
    return { fetch: replay.fetch, calls: replay.calls, done: () => undefined, live: false as const };
}

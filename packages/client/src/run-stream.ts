// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EventEnvelope } from '@ai-personal/shared';
import { AipNetworkError } from './errors.js';
import { parseSse } from './sse.js';
import type { Transport } from './transport.js';

/** 与 shared 的 SSE_EVENT_NAME / TERMINAL_EVENT_TYPES 保持一致(这里不在运行时加载 shared)。 */
const SSE_EVENT = 'agent';
const TERMINAL = new Set(['run-finished', 'run-failed']);

export interface StreamOptions {
    signal?: AbortSignal | undefined;
    /** 流在终止事件前断开时最多续看几次(每次收到新事件后重新计数),默认 5。 */
    maxReconnects?: number | undefined;
    /** 第 n 次(从 1 起)重连前的等待毫秒数,默认 500·2^(n-1),上限 8000。 */
    backoffMs?: ((attempt: number) => number) | undefined;
}

const defaultBackoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8000);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason as Error);
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal!.reason as Error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 一次运行的事件流(ADR 0004 第 5 节、ADR 0008)。迭代时依次产出 EventEnvelope,直到 run-finished / run-failed;
 * 中途断线会用 Last-Event-ID 自动续看并按 seq 去重。只能迭代一次。
 */
export class RunStream implements AsyncIterable<EventEnvelope> {
    /** 收到 run-started 后(或续看已知运行时)即可用。 */
    runId: string | null;
    /** 已产出的最大 seq。 */
    lastSeq: number;
    private started = false;

    constructor(
        private readonly transport: Transport,
        /** 首次打开流;运行未知时断线重连也用它(发送消息依靠 clientMessageId 保证幂等)。 */
        private readonly open: () => Promise<Response>,
        private readonly options: StreamOptions = {},
        known: { runId?: string; afterSeq?: number } = {},
    ) {
        this.runId = known.runId ?? null;
        this.lastSeq = known.afterSeq ?? 0;
    }

    /** 请求取消运行;运行已结束时服务器返回 409(此处抛出 AipApiError)。 */
    async cancel(): Promise<void> {
        if (!this.runId) throw new Error('The run has not started yet');
        await this.transport.json(`/runs/${encodeURIComponent(this.runId)}/cancel`, { method: 'POST' });
    }

    private resume(): Promise<Response> {
        return this.transport.raw(`/runs/${encodeURIComponent(this.runId!)}/events`, {
            headers: { accept: 'text/event-stream', 'last-event-id': String(this.lastSeq) },
            signal: this.options.signal,
        });
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
        if (this.started) throw new Error('A RunStream can only be iterated once');
        this.started = true;
        const { signal } = this.options;
        const maxReconnects = this.options.maxReconnects ?? 5;
        const backoff = this.options.backoffMs ?? defaultBackoff;
        let attempt = 0;
        let first = true;

        for (;;) {
            try {
                const res = first ? await this.open() : this.runId ? await this.resume() : await this.open();
                first = false;
                if (!res.body) throw new AipNetworkError('Empty event stream');
                for await (const message of parseSse(res.body)) {
                    if (message.event !== SSE_EVENT) continue;
                    const envelope = JSON.parse(message.data) as EventEnvelope;
                    if (envelope.seq <= this.lastSeq) continue;
                    this.lastSeq = envelope.seq;
                    attempt = 0;
                    if (envelope.event.type === 'run-started') this.runId = envelope.event.runId;
                    else if (!this.runId && 'runId' in envelope.event) this.runId = envelope.event.runId;
                    yield envelope;
                    if (TERMINAL.has(envelope.event.type)) return;
                }
            } catch (error) {
                first = false;
                if (signal?.aborted) throw error;
                // 服务器明确拒绝(4xx / 5xx problem)不重试,交给调用方
                if (!(error instanceof AipNetworkError) && !(error instanceof TypeError)) throw error;
            }
            // 流在终止事件之前结束:续看
            attempt += 1;
            if (attempt > maxReconnects) {
                throw new AipNetworkError(`The event stream ended early and ${maxReconnects} reconnects failed`);
            }
            await sleep(backoff(attempt), signal);
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EventBus, RunManager } from '@ai-personal/agent';
import { type EventEnvelope, isTerminalEvent, SSE_EVENT_NAME, SSE_HEARTBEAT_MS } from '@ai-personal/shared';
import type { Repositories } from '@ai-personal/storage';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from './env.js';

export interface RunStreamDeps {
    repos: Repositories;
    bus: EventBus;
    runs: RunManager;
}

const REPLAY_BATCH = 500;

/** Last-Event-ID 头或 ?after= 查询参数;都没有时从头开始。 */
export function resumeFrom(c: Context<AppEnv>): number {
    const raw = c.req.header('Last-Event-ID') ?? c.req.query('after');
    const n = raw === undefined ? 0 : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 以 SSE 推送某次运行的事件(ADR 0004 第 5 节):先订阅总线并缓存,再从库中补发 afterSeq 之后的事件,
 * 最后转为实时推送;遇到 run-finished / run-failed 后关闭。客户端断开只取消订阅,运行继续。
 */
export function streamRunEvents(
    c: Context<AppEnv>,
    deps: RunStreamDeps,
    ownerId: string,
    runId: string,
    afterSeq: number,
): Response {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
        let last = afterSeq;
        let closed = false;
        const pending: EventEnvelope[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = deps.bus.subscribe(ownerId, (envelope, eventRunId) => {
            if (eventRunId !== runId) return;
            pending.push(envelope);
            wake?.();
        });
        const heartbeat = setInterval(() => {
            void stream.write(': ping\n\n');
        }, SSE_HEARTBEAT_MS);
        stream.onAbort(() => {
            closed = true;
            wake?.();
        });

        /** 发送一个事件;返回是否为终止事件。 */
        const send = async (envelope: EventEnvelope): Promise<boolean> => {
            if (envelope.seq <= last) return false;
            last = envelope.seq;
            await stream.writeSSE({ id: String(envelope.seq), event: SSE_EVENT_NAME, data: JSON.stringify(envelope) });
            return isTerminalEvent(envelope.event);
        };

        try {
            // 补发库中已有的事件
            for (;;) {
                const batch = deps.repos.events.listRunAfter(ownerId, runId, last, REPLAY_BATCH);
                for (const envelope of batch) if (await send(envelope)) return;
                if (batch.length < REPLAY_BATCH) break;
            }
            // 运行已结束但没有终止事件(不应发生):直接关闭,避免客户端一直等待
            if (!deps.runs.isActive(runId) && pending.length === 0) return;
            // 实时推送
            while (!closed) {
                while (pending.length > 0) if (await send(pending.shift()!)) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
                wake = null;
            }
        } finally {
            clearInterval(heartbeat);
            unsubscribe();
        }
    });
}

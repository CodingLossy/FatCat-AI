// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { FatCatClient, RunStream } from '@fatcat-ai/client';
import { ask, type Ctx, lineReader, status } from './io.js';
import type { Interface } from 'node:readline';

export type Decision = 'approve' | 'reject';
export type Approver = (request: { callId: string; summary: string }) => Promise<Decision>;

export interface TurnResult {
    outcome: 'finished' | 'failed' | 'cancelled';
    runId: string | null;
    assistantMessageId: string | null;
}

/**
 * 审批策略(ADR 0008):--approve-tools 自动批准;交互终端里询问(默认拒绝);否则自动拒绝。
 * rl 为 chat 已经打开的行读取器,ask 时为 null(临时打开一个)。
 */
export function approverFor(
    ctx: Ctx,
    options: { autoApprove: boolean; interactive: boolean; rl: Interface | null },
): Approver {
    const { autoApprove, interactive, rl } = options;
    return async ({ summary }) => {
        if (autoApprove) {
            status(ctx, `[approval] ${summary} → approved (--approve-tools)`);
            return 'approve';
        }
        if (!interactive) {
            status(ctx, `[approval] ${summary} → rejected (not interactive; pass --approve-tools to allow)`);
            return 'reject';
        }
        const reader = rl ?? lineReader(ctx);
        try {
            const answer = await ask(reader, `[approval] ${summary}\nAllow? [y/N] `);
            return answer?.trim().toLowerCase().startsWith('y') ? 'approve' : 'reject';
        } finally {
            if (!rl) reader.close();
        }
    };
}

/**
 * 消费一次运行的事件:正文写 stdout(--json 时每行一个 EventEnvelope),状态写 stderr。
 * 第一次 Ctrl+C 取消运行,第二次停止等待。
 */
export async function runTurn(
    ctx: Ctx,
    client: FatCatClient,
    start: (signal: AbortSignal) => RunStream,
    options: { json: boolean; approve: Approver },
): Promise<TurnResult> {
    const abort = new AbortController();
    const stream = start(abort.signal);
    const result: TurnResult = { outcome: 'failed', runId: null, assistantMessageId: null };
    let interrupts = 0;
    let wroteText = false;
    let endsWithNewline = true;

    const offInterrupt = ctx.onInterrupt(() => {
        interrupts += 1;
        if (interrupts === 1 && stream.runId) {
            status(ctx, '\n(cancelling…)');
            stream.cancel().catch(() => undefined);
        } else {
            abort.abort(new Error('Interrupted'));
        }
    });

    try {
        for await (const envelope of stream) {
            const event = envelope.event;
            if (options.json) ctx.stdout.write(`${JSON.stringify(envelope)}\n`);
            switch (event.type) {
                case 'run-started':
                    result.runId = event.runId;
                    result.assistantMessageId = event.assistantMessageId;
                    break;
                case 'text-delta':
                    if (!options.json && event.delta) {
                        ctx.stdout.write(event.delta);
                        wroteText = true;
                        endsWithNewline = event.delta.endsWith('\n');
                    }
                    break;
                case 'tool-call':
                    status(ctx, `[tool] ${event.name}`);
                    break;
                case 'tool-result':
                    if (event.error) status(ctx, `[tool] failed: ${event.error}`);
                    break;
                case 'approval-required': {
                    const decision = await options.approve({ callId: event.callId, summary: event.summary });
                    await client.approvals.decide(event.callId, decision);
                    break;
                }
                case 'run-finished':
                    result.outcome = event.reason === 'cancelled' ? 'cancelled' : 'finished';
                    if (event.reason === 'length') status(ctx, '(stopped: output length limit)');
                    break;
                case 'run-failed':
                    result.outcome = 'failed';
                    status(ctx, `error: ${event.error.title}${event.error.detail ? `: ${event.error.detail}` : ''}`);
                    break;
                default:
                    // 未知或不需要显示的事件(如 assistant-state)忽略(ADR 0004)
                    break;
            }
        }
    } catch (error) {
        if (!abort.signal.aborted) throw error;
        result.outcome = 'cancelled';
    } finally {
        offInterrupt();
        if (!options.json && wroteText && !endsWithNewline) ctx.stdout.write('\n');
    }
    if (result.outcome === 'cancelled') status(ctx, '(cancelled)');
    return result;
}

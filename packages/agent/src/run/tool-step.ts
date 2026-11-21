// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 一步里的工具调用(ADR 0010、0042):哪些工具交给模型、未知工具的原因、工具上下文、
// 每个调用的审批与执行、结果回填,以及不可信内容的标记。根运行与子运行共用同一份逻辑。
import { toolInSet } from '@fatcat-ai/shared';
import type { ChatMessage, ToolCall } from '@fatcat-ai/providers';
import { newId } from '@fatcat-ai/storage';
import { type DelegateRequest, type ToolContext, ToolDeniedError } from '@fatcat-ai/tools';
import { assistantLabel } from '../labels.js';
import { auditCall, gate } from './approval-gate.js';
import type { LoopCtx, RunHost, ToolOutcome } from './common.js';
import { delegate, mayDelegate } from './delegation.js';

export function isWithheld(host: RunHost, ctx: LoopCtx, name: string): boolean {
    return (
        ctx.withheldPrefixes.some((prefix) => name.startsWith(prefix)) ||
        (ctx.noMemory && name.startsWith('memory.')) ||
        ctx.toolSets.some(({ set }) => !toolInSet(name, set)) ||
        (name === 'delegate' && !mayDelegate(host, ctx))
    );
}

export function unknownToolReason(ctx: LoopCtx, name: string): string {
    for (const { set, label } of ctx.toolSets) {
        if (!toolInSet(name, set)) return `unknown tool: ${name} (not in this ${label}'s tool set)`;
    }
    if (ctx.noMemory && name.startsWith('memory.')) return `unknown tool: ${name} (this agent does not use memory)`;
    if (name === 'delegate') return 'unknown tool: delegate (delegation is not available here)';
    return `unknown tool: ${name}`;
}

export function toolContextFor(host: RunHost, ctx: LoopCtx): ToolContext {
    return {
        ownerId: ctx.ownerId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        userMessageId: ctx.userMessageId,
        assistantMessageId: ctx.assistantMessageId,
        untrustedContentSeen: ctx.untrusted.seen,
        ...(ctx.task ? { task: ctx.task } : {}),
        ...(mayDelegate(host, ctx) ? { delegate: (request: DelegateRequest) => delegate(host, ctx, request) } : {}),
    };
}

/**
 * 执行一步里的所有工具调用并把结果回填给模型。同一步里的多个 delegate 并行执行(每个运行内最多
 * delegateParallelism 个),其他工具按顺序。返回 true 表示被取消。
 */
export async function runCalls(
    host: RunHost,
    ctx: LoopCtx,
    calls: ToolCall[],
    messages: ChatMessage[],
): Promise<boolean> {
    type Settled = { outcome: ToolOutcome } | { failure: unknown };
    const pending: Promise<Settled>[] = [];
    for (const call of calls) {
        const running: Promise<Settled> = runToolCall(host, ctx, call).then(
            (outcome) => ({ outcome }),
            (failure: unknown) => ({ failure }),
        );
        pending.push(call.name === 'delegate' ? running : Promise.resolve(await running));
    }
    const settled = await Promise.all(pending);
    let cancelled = false;
    settled.forEach((result, i) => {
        if ('failure' in result) throw result.failure;
        if (result.outcome === 'cancelled') {
            cancelled = true;
            return;
        }
        const { output, error } = result.outcome;
        messages.push({
            role: 'tool',
            toolCallId: calls[i]!.callId,
            content: JSON.stringify(error === undefined ? output : { error }),
        });
    });
    return cancelled;
}

/** 一次工具调用:校验、审批、执行、审计;根运行与子运行用同一份逻辑,审批与越权规则不因委派而放宽。 */
async function runToolCall(host: RunHost, ctx: LoopCtx, call: ToolCall): Promise<ToolOutcome> {
    const { repos } = host.options;
    const tools = host.options.tools;
    const { ownerId, sessionId } = ctx;
    // 对外的 callId 由服务器生成,保证全局唯一;模型侧的 id 只用于回填工具结果
    const callId = newId();
    const tool = isWithheld(host, ctx, call.name) ? undefined : tools?.get(call.name);
    ctx.emit({ type: 'tool-call', runId: ctx.runId, callId, name: call.name, input: call.input });
    ctx.parts.push({ type: 'tool-call', callId, name: call.name, input: call.input });

    let output: unknown = null;
    let error: string | undefined;
    if (!tool) {
        error = unknownToolReason(ctx, call.name);
        auditCall(host, ownerId, sessionId, ctx.runId, callId, call, null, 'denied', 'not_run', error);
    } else {
        const verdict = await gate(host, ctx, tool, call, callId, () => toolContextFor(host, ctx));
        if (verdict === 'cancelled') return 'cancelled';
        let { auditDecision, approved } = verdict;
        const { approvalRequestedAt, approvalVia } = verdict;
        error = verdict.error;
        if (approved) {
            ctx.emit({
                type: 'assistant-state',
                state: 'executing',
                toolName: tool.name,
                label: assistantLabel('executing', ctx.locale, tool),
            });
            try {
                output = await tool.execute(call.input, {
                    ...toolContextFor(host, ctx),
                    ...(approvalRequestedAt ? { approvalRequestedAt } : {}),
                });
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
                // 工具判定越权(如路径在授权目录外):按拒绝审计,read 工具也一样
                if (e instanceof ToolDeniedError) {
                    auditDecision = 'denied';
                    approved = false;
                }
            }
            if (tool.untrustedOutput && !ctx.untrusted.seen) {
                ctx.untrusted.seen = true;
                repos.sessions.markUntrusted(sessionId);
            }
        }
        // read 工具的普通调用不审计;经过审批流程或被拒绝的调用都审计(ADR 0010 第 6 节)
        if (tool.risk !== 'read' || auditDecision !== 'auto') {
            const outcome = !approved ? 'not_run' : error === undefined ? 'ok' : 'error';
            auditCall(
                host,
                ownerId,
                sessionId,
                ctx.runId,
                callId,
                call,
                tool,
                auditDecision,
                outcome,
                error,
                approvalVia,
            );
        }
    }
    const result = error === undefined ? {} : { error };
    ctx.emit({ type: 'tool-result', runId: ctx.runId, callId, output, ...result });
    ctx.parts.push({ type: 'tool-result', callId, output, ...result });
    return error === undefined ? { output } : { output, error };
}

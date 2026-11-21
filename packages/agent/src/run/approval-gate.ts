// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 审批闸(ADR 0010、0039):预授权匹配(含任务级白名单)、会话内已批准与 forceApproval(由 decide 判断)、
// 审批请求的创建、等待与超时、用户的决定,以及工具调用的审计。
import type {
    ApprovalPreview,
    ApprovalWarning,
    AuditEntry,
    PreauthRemember,
    Preauthorization,
} from '@fatcat-ai/shared';
import type { ToolCall } from '@fatcat-ai/providers';
import {
    decide,
    inputDigest,
    isPreauthorizable,
    prepareRemember,
    redactedInput,
    type ToolContext,
    type ToolDefinition,
} from '@fatcat-ai/tools';
import type { ApprovalOutcome } from '../tools.js';
import { type ApprovalVia, type Decision, type LoopCtx, redactOf, type Resolution, type RunHost } from './common.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

function audit(host: RunHost, ownerId: string, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    host.options.repos.audit.append(ownerId, entry);
}

/**
 * 处理审批。只有 pending 的请求能被决定,多端同时审批时只有第一个生效(条件更新,ADR 0010 第 5 节)。
 * remember 只能在批准时使用,external / dangerous 工具不允许预授权。
 * via:IM 渠道的审批(ADR 0022 第 6 节)走同一个函数,审计摘要末尾注明「via channel <id>」。
 */
export function resolveApproval(
    host: RunHost,
    ownerId: string,
    callId: string,
    decision: Decision,
    remember?: PreauthRemember,
    via?: ApprovalVia,
): ApprovalOutcome {
    const { repos } = host.options;
    const pending = host.approvals.get(callId);
    const request = repos.approvals.get(ownerId, callId);
    if (!pending || pending.ownerId !== ownerId || !request || request.status !== 'pending') return 'not_pending';
    let saved: PreauthRemember | undefined;
    if (remember) {
        if (decision !== 'approve') return { invalid: 'remember is only allowed when approving' };
        const tool = host.options.tools?.get(request.toolName);
        if (!tool) return { invalid: 'the tool is no longer available' };
        // 约束先规范化再保存(例如路径先 realpath,ADR 0011 第 4 节)
        const prepared = prepareRemember(tool, remember, { ownerId });
        if ('error' in prepared) return { invalid: prepared.error };
        saved = prepared.ok;
    }
    if (!repos.approvals.decide(ownerId, callId, decision === 'approve' ? 'approved' : 'rejected')) {
        return 'not_pending';
    }
    if (saved) {
        const preauth = repos.preauths.create(ownerId, {
            toolName: request.toolName,
            scope: saved.scope,
            sessionId: request.sessionId,
            constraint: saved.constraint ?? null,
        });
        audit(host, ownerId, {
            action: 'preauth-created',
            toolName: request.toolName,
            risk: request.risk,
            callId,
            runId: request.runId,
            sessionId: request.sessionId,
            decision: null,
            outcome: 'ok',
            summary: `Pre-authorized ${request.toolName} (${preauth.scope})`,
            inputDigest: preauth.constraint ? inputDigest(preauth.constraint, redactOf(host)) : null,
            error: null,
        });
    }
    host.approvals.delete(callId);
    pending.resolve({ decision, reason: 'user', ...(via ? { via } : {}) });
    return 'resolved';
}

/** 等待用户决定;到期时把请求标为 expired,运行取消时标为 cancelled,两者都按拒绝处理。 */
function waitForApproval(
    host: RunHost,
    ownerId: string,
    callId: string,
    signal: AbortSignal,
    expiresInMs: number,
): Promise<Resolution> {
    const { repos } = host.options;
    return new Promise((resolve) => {
        if (signal.aborted) {
            repos.approvals.decide(ownerId, callId, 'cancelled');
            resolve({ decision: 'reject', reason: 'cancelled' });
            return;
        }
        const timer = setTimeout(() => {
            if (repos.approvals.decide(ownerId, callId, 'expired')) {
                settle({ decision: 'reject', reason: 'expired' });
            }
        }, expiresInMs);
        const onAbort = () => {
            repos.approvals.decide(ownerId, callId, 'cancelled');
            settle({ decision: 'reject', reason: 'cancelled' });
        };
        const settle = (r: Resolution) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            host.approvals.delete(callId);
            resolve(r);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        host.approvals.set(callId, { ownerId, resolve: settle });
    });
}

function decideCall(host: RunHost, tool: ToolDefinition, input: unknown, context: ToolContext) {
    const { options } = host;
    // 库里以前存下的、缺了必填约束的条目(例如没有域名的 web.fetch)等于放行所有目标:不采用(ADR 0039)
    const required = tool.requireConstraint;
    const stored = options.repos.preauths
        .forTool(context.ownerId, tool.name, context.sessionId)
        .filter((p) => !required || Boolean(p.constraint?.[required]));
    // 任务级白名单:合成「只在本会话有效」的预授权;decide 对 external / dangerous 工具不看预授权,所以白名单绕不过审批
    const task = host.taskRuns.get(context.runId);
    const preauths: Preauthorization[] = [
        ...stored,
        ...(task?.allowedTools ?? [])
            .filter((a) => a.tool === tool.name && (!required || Boolean(a.constraint?.[required])))
            .map((a, i) => ({
                id: `task-${task!.id}-${i}`,
                toolName: a.tool,
                scope: 'session' as const,
                sessionId: context.sessionId,
                constraint: a.constraint ?? null,
                createdAt: new Date(host.now()).toISOString(),
                lastUsedAt: null,
            })),
    ];
    return decide(tool, input, context, preauths, {
        enableDangerous: options.tools?.options.enableDangerous,
        disableConditional: options.disableConditional?.(context.ownerId),
    });
}

export function auditCall(
    host: RunHost,
    ownerId: string,
    sessionId: string,
    runId: string,
    callId: string,
    call: ToolCall,
    tool: ToolDefinition | null,
    decision: NonNullable<AuditEntry['decision']>,
    outcome: AuditEntry['outcome'],
    error?: string,
    via?: ApprovalVia,
): void {
    const redact = redactOf(host);
    let summary = call.name;
    if (tool) {
        try {
            summary = tool.summarize(call.input);
        } catch {
            summary = tool.name;
        }
    }
    audit(host, ownerId, {
        action: 'tool-call',
        toolName: call.name,
        risk: tool?.risk ?? null,
        callId,
        runId,
        sessionId,
        decision,
        outcome,
        summary: (via
            ? `${summary.slice(0, 400)} (via channel ${via.channelId})`
            : host.taskRuns.has(runId)
              ? `${summary.slice(0, 400)} (via task ${host.taskRuns.get(runId)!.id})`
              : summary
        ).slice(0, 500),
        inputDigest: inputDigest(call.input, redact),
        error: error ? redact(error).slice(0, 2000) : null,
    });
}

/** 闸门的结论:cancelled 表示等待审批时运行被取消(已审计)。 */
export type GateResult =
    | 'cancelled'
    | {
          approved: boolean;
          auditDecision: NonNullable<AuditEntry['decision']>;
          error?: string;
          approvalRequestedAt?: string;
          approvalVia?: ApprovalVia;
      };

/**
 * 一次工具调用要不要执行:先按策略判断(拒绝 / 直接执行 / 询问),需要询问时创建审批请求、发出事件并等待。
 * contextFor 每次调用都重新取工具上下文(untrustedContentSeen 取调用时的值)。
 */
export async function gate(
    host: RunHost,
    ctx: LoopCtx,
    tool: ToolDefinition,
    call: ToolCall,
    callId: string,
    contextFor: () => ToolContext,
): Promise<GateResult> {
    const { options } = host;
    const { repos } = options;
    const { ownerId, sessionId } = ctx;
    const verdict = decideCall(host, tool, call.input, contextFor());
    if (verdict.action === 'deny') return { approved: false, auditDecision: 'denied', error: verdict.reason };
    if (verdict.action === 'run') {
        if (verdict.preauthId) repos.preauths.touch(verdict.preauthId);
        return { approved: true, auditDecision: verdict.decision };
    }
    const timeout = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const expiresAt = new Date(host.now() + timeout);
    const askContext = contextFor();
    const base = tool.summarize(call.input, askContext);
    const summary = ctx.initiator ? `[${ctx.initiator}] ${base}` : base;
    // 警示只是附加提示:工具自己的 warnings 出错时不带警示,审批照常发出(仍然要人批准)
    let warnings: ApprovalWarning[];
    try {
        warnings = tool.warnings?.(call.input, askContext) ?? [];
    } catch {
        warnings = [];
    }
    let preview: ApprovalPreview | undefined;
    try {
        preview = tool.preview?.(call.input, askContext);
    } catch {
        // 预览只用于显示;失败时审批照常
    }
    const request = repos.approvals.create(ownerId, {
        callId,
        runId: ctx.runId,
        sessionId,
        toolName: tool.name,
        risk: tool.risk,
        summary,
        input: redactedInput(call.input, redactOf(host)),
        preauthorizable: isPreauthorizable(tool),
        expiresAt,
        ...(warnings.length > 0 ? { warnings } : {}),
    });
    repos.runs.setStatus(ctx.runId, 'waiting_approval');
    ctx.persist();
    ctx.emit({
        type: 'approval-required',
        runId: ctx.runId,
        callId,
        summary,
        toolName: tool.name,
        risk: tool.risk,
        expiresAt: expiresAt.toISOString(),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(preview ? { preview } : {}),
    });
    const resolution = await waitForApproval(host, ownerId, callId, ctx.signal, timeout);
    if (ctx.signal.aborted) {
        auditCall(host, ownerId, sessionId, ctx.runId, callId, call, tool, 'cancelled', 'not_run');
        return 'cancelled';
    }
    ctx.emit({
        type: 'approval-resolved',
        runId: ctx.runId,
        callId,
        decision: resolution.decision,
        reason: resolution.reason,
    });
    repos.runs.setStatus(ctx.runId, 'running');
    const approved = resolution.decision === 'approve';
    return {
        approved,
        auditDecision: approved ? 'approved' : resolution.reason === 'expired' ? 'expired' : 'rejected',
        approvalRequestedAt: request.createdAt,
        ...(resolution.via ? { approvalVia: resolution.via } : {}),
        ...(approved
            ? {}
            : {
                  error:
                      resolution.reason === 'expired'
                          ? 'the approval request expired'
                          : 'the user rejected this action',
              }),
    };
}

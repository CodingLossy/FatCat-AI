// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 进行中的一轮对话:把一次运行的事件归并成可渲染的状态(ADR 0009 第 3 节)。纯函数,便于单测。
import type { ApprovalWarning, EventEnvelope, MemoryDegradation, ProblemDetails, ToolRisk } from '@fatcat-ai/shared';

export interface LiveTool {
    callId: string;
    name: string;
    input: unknown;
    /** 待审批时的摘要;decision 为空表示仍在等待。 */
    approval?: {
        summary: string;
        risk?: ToolRisk;
        /** core 生成的审批警告(ADR 0016 第 8 节)。 */
        warnings?: ApprovalWarning[];
        decision?: 'approve' | 'reject';
        reason?: 'user' | 'expired' | 'cancelled';
    };
    result?: { output: unknown; error?: string };
}

export interface LiveTurn {
    runId: string | null;
    /** 刚发送、服务器尚未保存的用户消息(续看时为空,用户消息已在消息列表中)。 */
    userText: string | null;
    text: string;
    tools: LiveTool[];
    /** 本轮用到的记忆(memory-used 事件,ADR 0007 第 5.6 节)。 */
    memoryIds: string[];
    /** 召回没有跑完的路径(memory-used 的 degraded,ADR 0017);旧服务器不发送,为空。 */
    memoryDegraded: MemoryDegradation[];
    /** 因预算没有展示给模型的相关记忆条数(memory-used 的 omitted)。 */
    memoryOmitted: number;
    done: boolean;
    finishReason?: 'stop' | 'length' | 'cancelled';
    error?: ProblemDetails;
}

export function newTurn(userText: string | null, runId: string | null = null): LiveTurn {
    return { runId, userText, text: '', tools: [], memoryIds: [], memoryDegraded: [], memoryOmitted: 0, done: false };
}

function updateTool(turn: LiveTurn, callId: string, fn: (t: LiveTool) => LiveTool): LiveTurn {
    return { ...turn, tools: turn.tools.map((t) => (t.callId === callId ? fn(t) : t)) };
}

/** 归并一个事件;未知事件类型原样返回(ADR 0004:客户端须忽略未知类型)。 */
export function applyEvent(turn: LiveTurn, envelope: EventEnvelope): LiveTurn {
    const e = envelope.event;
    switch (e.type) {
        case 'run-started':
            return { ...turn, runId: e.runId };
        case 'text-delta':
            return { ...turn, text: turn.text + e.delta };
        case 'tool-call':
            if (turn.tools.some((t) => t.callId === e.callId)) return turn;
            return { ...turn, tools: [...turn.tools, { callId: e.callId, name: e.name, input: e.input }] };
        case 'approval-required':
            return updateTool(turn, e.callId, (t) => ({
                ...t,
                approval: {
                    summary: e.summary,
                    ...(e.risk ? { risk: e.risk } : {}),
                    ...(e.warnings?.length ? { warnings: e.warnings } : {}),
                },
            }));
        case 'approval-resolved':
            return updateTool(turn, e.callId, (t) => ({
                ...t,
                approval: {
                    ...t.approval,
                    summary: t.approval?.summary ?? '',
                    decision: e.decision,
                    ...(e.reason ? { reason: e.reason } : {}),
                },
            }));
        case 'tool-result':
            return updateTool(turn, e.callId, (t) => ({
                ...t,
                result: { output: e.output, ...(e.error ? { error: e.error } : {}) },
            }));
        case 'memory-used':
            return {
                ...turn,
                memoryIds: [...new Set([...turn.memoryIds, ...e.ids])],
                memoryDegraded: e.degraded ?? turn.memoryDegraded,
                memoryOmitted: e.omitted ?? turn.memoryOmitted,
            };
        case 'run-finished':
            return { ...turn, done: true, finishReason: e.reason };
        case 'run-failed':
            return { ...turn, done: true, error: e.error };
        default:
            return turn;
    }
}

/** 仍在等待用户决定的审批。 */
export function pendingApprovals(turn: LiveTurn | null): LiveTool[] {
    return turn ? turn.tools.filter((t) => t.approval && !t.approval.decision) : [];
}

/** 与 shared 的 ApiKeyRef 相同的规则;null / 空串表示不需要密钥。 */
export const KEY_REF_PATTERN = /^(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isValidKeyRef(value: string): boolean {
    return value === '' || KEY_REF_PATTERN.test(value);
}

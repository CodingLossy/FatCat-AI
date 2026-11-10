// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { Id, IsoDateTime, Usage } from './common.js';
import { ProblemDetails } from './errors.js';
import { ApprovalWarning, ToolRisk } from './tools.js';

export const AssistantState = z.enum(['idle', 'listening', 'thinking', 'speaking', 'executing']);
export type AssistantState = z.infer<typeof AssistantState>;

/**
 * Agent 运行中产生的事件(计划第 6 节,M1 补充 run-started / run-failed / approval-resolved)。
 * 只能增加新类型或可选字段;客户端须忽略未知类型(ADR 0004)。
 */
export const AgentEvent = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('run-started'),
        runId: Id,
        sessionId: Id,
        userMessageId: Id,
        assistantMessageId: Id,
    }),
    z.object({ type: z.literal('text-delta'), runId: Id, delta: z.string() }),
    /** 本次运行用到的记忆(M2 PR 12 起发送,ADR 0007 第 5.4 节);UI 据此显示「本次用到的记忆」与反馈按钮。 */
    z.object({ type: z.literal('memory-used'), runId: Id, ids: z.array(Id) }),
    z.object({ type: z.literal('tool-call'), runId: Id, callId: z.string(), name: z.string(), input: z.unknown() }),
    z.object({
        type: z.literal('approval-required'),
        runId: Id,
        callId: z.string(),
        summary: z.string(),
        /** 以下字段自 M2 起提供(ADR 0010 第 9 节),旧服务器不发送。 */
        toolName: z.string().optional(),
        risk: ToolRisk.optional(),
        expiresAt: IsoDateTime.optional(),
        /** 自 M3 起提供(ADR 0016 第 8 节);没有警告时省略。 */
        warnings: z.array(ApprovalWarning).max(20).optional(),
    }),
    z.object({
        type: z.literal('approval-resolved'),
        runId: Id,
        callId: z.string(),
        decision: z.enum(['approve', 'reject']),
        /** 由谁 / 什么结束了审批;过期与运行取消都按 reject 处理(ADR 0010 第 5 节)。 */
        reason: z.enum(['user', 'expired', 'cancelled']).optional(),
    }),
    z.object({
        type: z.literal('tool-result'),
        runId: Id,
        callId: z.string(),
        output: z.unknown(),
        error: z.string().optional(),
    }),
    z.object({
        type: z.literal('run-finished'),
        runId: Id,
        reason: z.enum(['stop', 'length', 'cancelled']),
        usage: Usage.optional(),
    }),
    z.object({ type: z.literal('run-failed'), runId: Id, error: ProblemDetails }),
    z.object({
        type: z.literal('assistant-state'),
        state: AssistantState,
        label: z.string().optional(),
        toolName: z.string().optional(),
        level: z.number().min(0).max(1).optional(),
    }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent['type'];

/** 运行在这两类事件之后结束,服务器随即关闭 SSE 流。 */
export const TERMINAL_EVENT_TYPES = ['run-finished', 'run-failed'] as const satisfies readonly AgentEventType[];

export function isTerminalEvent(event: AgentEvent): boolean {
    return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}

/** 持久化后的事件信封;seq 按 owner 全局单调递增,SSE 与 WebSocket 共用(ADR 0004)。 */
export const EventEnvelope = z.object({
    seq: z.number().int().positive(),
    at: IsoDateTime,
    sessionId: Id.nullable(),
    event: AgentEvent,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** SSE 中 `event:` 字段的取值。 */
export const SSE_EVENT_NAME = 'agent';
/** SSE 心跳间隔(毫秒)。 */
export const SSE_HEARTBEAT_MS = 15_000;

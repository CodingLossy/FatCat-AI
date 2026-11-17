// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 定时任务的公开契约(ADR 0033)。本文件只新增 schema;触发器与动作的取值只增不改,
// 客户端必须把未知的 kind 当作「不认识的任务」显示,不能报错(ADR 0004)。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { pageOf } from './pagination.js';

/** 触发器。M6 PR 2:cron 与一次性;事件触发(新邮件、文件变化、Webhook)随 PR 4 加入。 */
export const TaskTrigger = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('cron'),
        /** 5 段 cron 表达式,按用户时区解释(ADR 0023);最小间隔 1 分钟。 */
        expression: z.string().trim().min(1).max(100),
    }),
    z.object({ kind: z.literal('once'), at: IsoDateTime }),
]);
export type TaskTrigger = z.infer<typeof TaskTrigger>;

/** 动作。PR 2 只有内置系统任务;`agent_prompt` 与 `tool_chain` 随 PR 3 加入。 */
export const TaskAction = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('system'), key: z.string().min(1).max(64) }),
]);
export type TaskAction = z.infer<typeof TaskAction>;

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

/** 静默时段(用户时区,可跨午夜):期间到点的运行按 behavior 处理。 */
export const TaskQuietHours = z.object({
    start: Clock,
    end: Clock,
    behavior: z.enum(['defer', 'skip']).default('defer'),
});
export type TaskQuietHours = z.infer<typeof TaskQuietHours>;

export const TaskPolicy = z.object({
    /** 可重试失败的最大尝试次数(含第一次)。 */
    maxAttempts: z.number().int().min(1).max(5),
    /** 错过(服务器关闭期间)的触发:skip 只记一行,catchUp 启动后补跑一次。 */
    misfire: z.enum(['skip', 'catchUp']),
    quietHours: TaskQuietHours.nullable(),
    maxRuntimeMinutes: z.number().int().min(1).max(120),
});
export type TaskPolicy = z.infer<typeof TaskPolicy>;

export const TaskRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'skipped', 'cancelled']);
export type TaskRunStatus = z.infer<typeof TaskRunStatus>;

export const TaskRunTrigger = z.enum(['schedule', 'catch_up', 'manual', 'event', 'retry']);
export type TaskRunTrigger = z.infer<typeof TaskRunTrigger>;

/** 错误码只有枚举,不含任何正文、模型输出或堆栈(ADR 0033 第 5 节)。 */
export const TaskErrorCode = z.enum([
    'timeout',
    'model_error',
    'approval_rejected',
    'approval_expired',
    'output_failed',
    'config_error',
    'throttled',
    'cancelled',
    'postponed',
    'missed',
    'quiet_hours',
    'overlap',
    'queue_full',
    'internal',
]);
export type TaskErrorCode = z.infer<typeof TaskErrorCode>;

export const TaskRun = z.object({
    id: Id,
    taskId: Id,
    trigger: TaskRunTrigger,
    /** 原定的触发时刻;手动运行时为创建时刻。 */
    scheduledFor: IsoDateTime,
    status: TaskRunStatus,
    attempt: z.number().int().min(1),
    errorCode: TaskErrorCode.nullable(),
    startedAt: IsoDateTime.nullable(),
    finishedAt: IsoDateTime.nullable(),
    createdAt: IsoDateTime,
});
export type TaskRun = z.infer<typeof TaskRun>;

export const Task = z.object({
    id: Id,
    name: z.string().min(1).max(80),
    kind: z.enum(['user', 'system']),
    status: z.enum(['draft', 'active', 'completed']),
    enabled: z.boolean(),
    trigger: TaskTrigger,
    action: TaskAction,
    policy: TaskPolicy,
    /** 下一次排定的运行时刻;停用、已完成或没有下一次时为 null。 */
    nextRunAt: IsoDateTime.nullable(),
    lastRun: TaskRun.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Task = z.infer<typeof Task>;

/** `PATCH /tasks/{id}`:至少给一个字段。系统任务只能改 enabled、trigger(cron)与 policy。 */
export const TaskPatch = z
    .object({
        name: z.string().trim().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        trigger: TaskTrigger.optional(),
        policy: TaskPolicy.optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type TaskPatch = z.infer<typeof TaskPatch>;

export const TaskPage = pageOf(Task);
export const TaskRunPage = pageOf(TaskRun);

/** `GET /tasks/schedule-preview?expression=…`:未来几次触发时刻(用户时区的 cron 展开)。 */
export const TaskSchedulePreview = z.object({
    timeZone: z.string(),
    times: z.array(IsoDateTime),
});
export type TaskSchedulePreview = z.infer<typeof TaskSchedulePreview>;

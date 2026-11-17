// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 定时任务的公开契约(ADR 0033)。本文件只新增 schema;触发器与动作的取值只增不改,
// 客户端必须把未知的 kind 当作「不认识的任务」显示,不能报错(ADR 0004)。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { PreauthConstraint } from './tools.js';
import { pageOf } from './pagination.js';

/** 触发器:cron、一次性,以及事件(新邮件、文件变化、Webhook)。事件触发器没有「下一次时刻」。 */
export const TaskTrigger = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('cron'),
        /** 5 段 cron 表达式,按用户时区解释(ADR 0023);最小间隔 1 分钟。 */
        expression: z.string().trim().min(1).max(100),
    }),
    z.object({ kind: z.literal('once'), at: IsoDateTime }),
    /** 邮件同步到新邮件时触发;只按账户匹配,不看邮件内容(ADR 0035)。不给 accountId 表示任意账户。 */
    z.object({ kind: z.literal('mail_received'), accountId: Id.optional() }),
    /** 已授权目录(fs_roots)内有文件变化时触发,5 秒去抖(ADR 0035)。 */
    z.object({ kind: z.literal('file_changed'), rootId: Id }),
    /** 外部系统调用 POST /hooks/{任务 id}(任务专属令牌)时触发(ADR 0035)。 */
    z.object({ kind: z.literal('webhook') }),
]);
export type TaskTrigger = z.infer<typeof TaskTrigger>;

/**
 * 动作:`system` 内置任务;`agent_prompt` 把一段提示词交给 Agent,在独立的任务会话里无人值守地运行(ADR 0034)。
 * `tool_chain` 尚未提供。
 */
export const TaskAction = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('system'), key: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('agent_prompt'), prompt: z.string().trim().min(1).max(2000) }),
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

/** 任务级预授权白名单的一项:只能是 read / write 级别的工具,可带 ADR 0010 的约束。默认整个白名单为空。 */
export const TaskAllowedTool = z.object({
    tool: z.string().min(1).max(100),
    constraint: PreauthConstraint.optional(),
});
export type TaskAllowedTool = z.infer<typeof TaskAllowedTool>;

/**
 * 输出去向。`conversation`:结果留在任务会话里(默认);`channel`:经 `channel.push` 推到主人自己绑定的渠道,
 * 每次都需要审批,不可预授权(ADR 0034 第 3 节)。
 */
export const TaskOutput = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('conversation') }),
    z.object({ kind: z.literal('channel'), channelId: Id }),
]);
export type TaskOutput = z.infer<typeof TaskOutput>;

export const TaskPolicy = z.object({
    /** 可重试失败的最大尝试次数(含第一次)。 */
    maxAttempts: z.number().int().min(1).max(5),
    /** 错过(服务器关闭期间)的触发:skip 只记一行,catchUp 启动后补跑一次。 */
    misfire: z.enum(['skip', 'catchUp']),
    quietHours: TaskQuietHours.nullable(),
    maxRuntimeMinutes: z.number().int().min(1).max(120),
    /** 无人值守时直接执行的工具;默认空。不能含 external / dangerous 工具。 */
    allowedTools: z.array(TaskAllowedTool).max(20).optional(),
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
    'over_budget',
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
    /** 任务会话(agent_prompt 的运行在这里);没有时为 null。 */
    sessionId: Id.nullable(),
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
    outputs: z.array(TaskOutput),
    policy: TaskPolicy,
    /** 任务本身有问题的提示码:root_revoked = 文件变化触发器引用的授权目录已被撤销(或不存在)。没有问题时为 null。 */
    warning: z.enum(['root_revoked']).nullable().optional(),
    /** 下一次排定的运行时刻;停用、已完成或没有下一次时为 null。 */
    nextRunAt: IsoDateTime.nullable(),
    lastRun: TaskRun.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Task = z.infer<typeof Task>;

/** `POST /tasks`:新建用户任务。policy 可省略(用默认值:最多 3 次尝试、cron 跳过错过、一次性补跑、最长 10 分钟)。 */
export const TaskCreate = z
    .object({
        name: z.string().trim().min(1).max(80),
        trigger: TaskTrigger,
        action: z.object({ kind: z.literal('agent_prompt'), prompt: z.string().trim().min(1).max(2000) }),
        outputs: z
            .array(TaskOutput)
            .max(3)
            .default([{ kind: 'conversation' }]),
        policy: TaskPolicy.optional(),
    })
    .strict();
export type TaskCreate = z.infer<typeof TaskCreate>;

/** `PATCH /tasks/{id}`:至少给一个字段。系统任务只能改 enabled、trigger(cron)与 policy。 */
export const TaskPatch = z
    .object({
        name: z.string().trim().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        trigger: TaskTrigger.optional(),
        policy: TaskPolicy.optional(),
        outputs: z.array(TaskOutput).max(3).optional(),
        action: z.object({ kind: z.literal('agent_prompt'), prompt: z.string().trim().min(1).max(2000) }).optional(),
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
/** `POST /tasks/{id}/webhook-token`:令牌明文只出现在这个响应里,服务器只存哈希。 */
export const TaskWebhookToken = z.object({ token: z.string(), url: z.string() });
export type TaskWebhookToken = z.infer<typeof TaskWebhookToken>;

export type TaskSchedulePreview = z.infer<typeof TaskSchedulePreview>;

/** `POST /tasks/propose`:一句话描述;解析结果只会成为草稿,不会生效(ADR 0036)。 */
export const TaskPropose = z.object({ text: z.string().trim().min(1).max(500) }).strict();
export type TaskPropose = z.infer<typeof TaskPropose>;

/** 草稿与提示:`warnings` 是人话(例如「没有已绑定的微信渠道,结果只留在会话里」)。 */
export const TaskDraftResult = z.object({ task: Task, warnings: z.array(z.string()) });
export type TaskDraftResult = z.infer<typeof TaskDraftResult>;

/** `POST /tasks/{id}/confirm`:`version` 是确认卡片上展示的草稿的 `updatedAt`,不一致则 409。 */
export const TaskConfirm = z.object({ version: IsoDateTime }).strict();
export type TaskConfirm = z.infer<typeof TaskConfirm>;

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 定时任务的 REST(ADR 0033 第 7 节):都需要登录并按 ownerId 取数据,别人的任务一律 404。
// PR 2 只有内置系统任务;用户自建任务的 POST /tasks 随 PR 3(动作与输出)加入。
import { createHash, randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import {
    effectiveTimeZone,
    Id,
    PageQuery,
    Task,
    TaskCreate,
    TaskPage,
    TaskPatch,
    TaskRun,
    TaskRunPage,
    TaskSchedulePreview,
    TaskWebhookToken,
    type Task as TaskDto,
    type TaskRun as TaskRunDto,
} from '@fatcat-ai/shared';
import { isPreauthorizable, type ToolRegistry } from '@fatcat-ai/tools';
import type { Repositories, TaskRecord, TaskRunRecord } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import type { Scheduler } from '../scheduler-setup.js';
import { nextTriggerTime, previewCron, validateCron } from '../scheduler/time.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['tasks'];
const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/tasks',
    tags,
    summary: 'List scheduled tasks (built-in system tasks and, later, user tasks)',
    responses: { 200: json(TaskPage, 'Tasks'), ...authErrors },
});
const previewRoute = createRoute({
    method: 'get',
    path: '/tasks/schedule-preview',
    tags,
    summary: 'Validate a cron expression and list its next fire times in the user time zone',
    request: {
        query: z.object({
            expression: z.string().min(1).max(100),
            count: z.coerce.number().int().min(1).max(10).default(3),
        }),
    },
    responses: { 200: json(TaskSchedulePreview, 'Next fire times'), 400: problem('Invalid expression'), ...authErrors },
});
const createTaskRoute = createRoute({
    method: 'post',
    path: '/tasks',
    tags,
    summary:
        'Create a task that hands a prompt to the Agent on a schedule. Anything that sends or writes still needs approval',
    request: { body: { content: { 'application/json': { schema: TaskCreate } }, required: true } },
    responses: { 201: json(Task, 'Created'), 400: problem('Invalid request'), ...authErrors },
});
const getRoute = createRoute({
    method: 'get',
    path: '/tasks/{id}',
    tags,
    summary: 'Get a task',
    request: { params: idParam },
    responses: { 200: json(Task, 'Task'), 404: problem('Not found'), ...authErrors },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/tasks/{id}',
    tags,
    summary: 'Enable or disable a task, change its schedule or policy. System tasks cannot be renamed',
    request: { params: idParam, body: { content: { 'application/json': { schema: TaskPatch } }, required: true } },
    responses: {
        200: json(Task, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/tasks/{id}',
    tags,
    summary: 'Delete a user task; system tasks can only be disabled',
    request: { params: idParam },
    responses: {
        204: { description: 'Deleted' },
        404: problem('Not found'),
        409: problem('System tasks cannot be deleted'),
        ...authErrors,
    },
});
const webhookTokenRoute = createRoute({
    method: 'post',
    path: '/tasks/{id}/webhook-token',
    tags,
    summary: 'Create or replace the webhook token of a webhook-triggered task; the plain token appears only here',
    request: { params: idParam },
    responses: {
        201: json(TaskWebhookToken, 'Token'),
        404: problem('Not found'),
        409: problem('The task does not use a webhook trigger'),
        ...authErrors,
    },
});
const runRoute = createRoute({
    method: 'post',
    path: '/tasks/{id}/run',
    tags,
    summary: 'Run a task now; 409 if it already has a queued or running run',
    request: { params: idParam },
    responses: {
        202: json(TaskRun, 'Queued run'),
        404: problem('Not found'),
        409: problem('The task is already queued or running'),
        ...authErrors,
    },
});
const runsRoute = createRoute({
    method: 'get',
    path: '/tasks/{id}/runs',
    tags,
    summary: 'Run records of a task, newest first (metadata only: status, error code, times)',
    request: { params: idParam, query: PageQuery },
    responses: { 200: json(TaskRunPage, 'Runs'), 404: problem('Not found'), ...authErrors },
});
const runGetRoute = createRoute({
    method: 'get',
    path: '/task-runs/{id}',
    tags,
    summary: 'Get one run record',
    request: { params: idParam },
    responses: { 200: json(TaskRun, 'Run'), 404: problem('Not found'), ...authErrors },
});
const cancelRoute = createRoute({
    method: 'post',
    path: '/task-runs/{id}/cancel',
    tags,
    summary: 'Cancel a queued or running run',
    request: { params: idParam },
    responses: {
        200: json(TaskRun, 'Run after the cancel request'),
        404: problem('Not found'),
        409: problem('The run has already finished'),
        ...authErrors,
    },
});

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function toTaskRun(run: TaskRunRecord): TaskRunDto {
    return { ...run };
}

export function taskRoutes(deps: { repos: Repositories; scheduler: Scheduler; tools?: ToolRegistry | undefined }) {
    const { repos, scheduler } = deps;
    const timeZoneOf = (ownerId: string) => effectiveTimeZone(repos.settings.get(ownerId).timeZone);
    const taskOr404 = (ownerId: string, id: string) => {
        const task = repos.tasks.get(ownerId, id);
        if (!task) throw notFound('Task');
        return task;
    };
    const toTask = (task: TaskRecord): TaskDto => {
        const next = task.enabled && task.status === 'active' ? scheduler.engine.nextRun(task.id) : null;
        const last = repos.tasks.lastRun(task.id);
        return {
            id: task.id,
            name: task.name,
            kind: task.kind,
            status: task.status,
            enabled: task.enabled,
            trigger: task.trigger,
            action: task.action,
            outputs: task.outputs,
            policy: task.policy,
            nextRunAt: next ? next.toISOString() : null,
            lastRun: last ? toTaskRun(last) : null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    };
    const invalid = (message: string, path: (string | number)[]) =>
        new ApiError(400, 'validation_failed', 'Bad Request', message, { issues: [{ path, message }] });
    /** 输出与白名单的校验(ADR 0034 第 3 节):渠道必须属于主人;白名单只能是存在且可预授权的工具。 */
    const checkOutputsAndPolicy = (
        ownerId: string,
        outputs: TaskDto['outputs'] | undefined,
        policy: TaskDto['policy'] | undefined,
    ) => {
        outputs?.forEach((output, i) => {
            if (output.kind === 'channel' && !repos.channels.get(ownerId, output.channelId)) {
                throw invalid('The channel does not exist.', ['outputs', i, 'channelId']);
            }
        });
        policy?.allowedTools?.forEach((entry, i) => {
            const tool = deps.tools?.get(entry.tool);
            if (!tool) throw invalid('Unknown tool.', ['policy', 'allowedTools', i, 'tool']);
            if (!isPreauthorizable(tool)) {
                throw invalid(
                    `${tool.name} sends or runs things outside this machine and always needs approval; it cannot be allow-listed.`,
                    ['policy', 'allowedTools', i, 'tool'],
                );
            }
        });
    };
    /** 触发器的校验:cron / 一次性 / 事件触发器引用的账户与目录必须属于主人。 */
    const checkTrigger = (ownerId: string, trigger: TaskDto['trigger']) => {
        const timeZone = timeZoneOf(ownerId);
        if (trigger.kind === 'cron') {
            const error = validateCron(trigger.expression, timeZone);
            if (error) throw invalid(error, ['trigger', 'expression']);
        } else if (trigger.kind === 'once') {
            if (!nextTriggerTime(trigger, timeZone, new Date()))
                throw invalid('The time is in the past.', ['trigger', 'at']);
        } else if (trigger.kind === 'mail_received') {
            if (trigger.accountId && !repos.mail.get(ownerId, trigger.accountId)) {
                throw invalid('The mail account does not exist.', ['trigger', 'accountId']);
            }
        } else if (trigger.kind === 'file_changed') {
            if (!repos.fsRoots.list(ownerId).some((r) => r.id === trigger.rootId)) {
                throw invalid('The directory is not an authorized directory.', ['trigger', 'rootId']);
            }
        }
    };
    const runOr404 = (ownerId: string, id: string) => {
        const run = repos.tasks.getRun(id);
        if (!run || !repos.tasks.get(ownerId, run.taskId)) throw notFound('Task run');
        return run;
    };

    return router()
        .openapi(listRoute, (c) => {
            const ownerId = requireOwner(c);
            if (scheduler.ensureSystemTasks(ownerId)) scheduler.engine.rescheduleAll();
            return c.json({ items: repos.tasks.list(ownerId).map(toTask), nextCursor: null }, 200);
        })
        .openapi(previewRoute, (c) => {
            const ownerId = requireOwner(c);
            const { expression, count } = c.req.valid('query');
            const timeZone = timeZoneOf(ownerId);
            const error = validateCron(expression, timeZone);
            if (error) {
                throw new ApiError(400, 'validation_failed', 'Bad Request', error, {
                    issues: [{ path: ['expression'], message: error }],
                });
            }
            const times = previewCron(expression, timeZone, new Date(), count).map((d) => d.toISOString());
            return c.json({ timeZone, times }, 200);
        })
        .openapi(createTaskRoute, (c) => {
            const ownerId = requireOwner(c);
            const body = c.req.valid('json');
            checkTrigger(ownerId, body.trigger);
            const policy = body.policy ?? {
                maxAttempts: 3,
                misfire: body.trigger.kind === 'once' ? ('catchUp' as const) : ('skip' as const),
                quietHours: null,
                maxRuntimeMinutes: 10,
            };
            checkOutputsAndPolicy(ownerId, body.outputs, policy);
            const task = repos.tasks.createUser(ownerId, { ...body, policy });
            scheduler.engine.rescheduleAll();
            scheduler.syncWatchers();
            return c.json(toTask(task), 201);
        })
        .openapi(getRoute, (c) => c.json(toTask(taskOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const task = taskOr404(ownerId, c.req.valid('param').id);
            const body = c.req.valid('json');
            if (task.kind === 'system' && body.name !== undefined) {
                throw new ApiError(400, 'validation_failed', 'Bad Request', 'System tasks cannot be renamed.');
            }
            if (task.kind === 'system' && (body.action || body.outputs)) {
                throw invalid('System tasks cannot change their action or outputs.', [
                    body.action ? 'action' : 'outputs',
                ]);
            }
            checkOutputsAndPolicy(ownerId, body.outputs, body.policy);
            if (body.trigger) {
                if (task.kind === 'system' && body.trigger.kind !== 'cron') {
                    throw invalid('System tasks use cron triggers.', ['trigger']);
                }
                checkTrigger(ownerId, body.trigger);
            }
            if (task.trigger.kind === 'webhook' && body.trigger && body.trigger.kind !== 'webhook') {
                repos.tasks.deleteWebhookToken(task.id);
            }
            const updated = repos.tasks.update(ownerId, task.id, {
                ...body,
                // 重新启用已完成的一次性任务没有意义;改了触发器的任务回到 active
                ...(body.trigger && task.status === 'completed' ? { status: 'active' as const } : {}),
            })!;
            scheduler.engine.rescheduleAll();
            scheduler.syncWatchers();
            return c.json(toTask(updated), 200);
        })
        .openapi(deleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const task = taskOr404(ownerId, c.req.valid('param').id);
            if (task.kind === 'system') {
                throw new ApiError(
                    409,
                    'conflict',
                    'Conflict',
                    'System tasks cannot be deleted; disable them instead.',
                );
            }
            repos.tasks.delete(ownerId, task.id);
            scheduler.engine.rescheduleAll();
            scheduler.syncWatchers();
            return c.body(null, 204);
        })
        .openapi(webhookTokenRoute, (c) => {
            const task = taskOr404(requireOwner(c), c.req.valid('param').id);
            if (task.trigger.kind !== 'webhook') {
                throw new ApiError(409, 'conflict', 'Conflict', 'The task does not use a webhook trigger.');
            }
            const token = `fcwh_${randomBytes(24).toString('base64url')}`;
            repos.tasks.setWebhookTokenHash(task.id, hashToken(token));
            return c.json({ token, url: `/hooks/${task.id}` }, 201);
        })
        .openapi(runRoute, (c) => {
            const task = taskOr404(requireOwner(c), c.req.valid('param').id);
            const run = scheduler.engine.runNow(task.id);
            if (!run) throw new ApiError(409, 'conflict', 'Conflict', 'The task is already queued or running.');
            return c.json(toTaskRun(run), 202);
        })
        .openapi(runsRoute, (c) => {
            const task = taskOr404(requireOwner(c), c.req.valid('param').id);
            const { cursor, limit } = c.req.valid('query');
            const page = repos.tasks.listRuns(task.id, { cursor, limit });
            return c.json({ items: page.items.map(toTaskRun), nextCursor: page.nextCursor }, 200);
        })
        .openapi(runGetRoute, (c) => c.json(toTaskRun(runOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(cancelRoute, (c) => {
            const run = runOr404(requireOwner(c), c.req.valid('param').id);
            if (!scheduler.engine.cancel(run.id)) {
                throw new ApiError(409, 'conflict', 'Conflict', 'The run has already finished.');
            }
            return c.json(toTaskRun(repos.tasks.getRun(run.id) ?? run), 200);
        });
}

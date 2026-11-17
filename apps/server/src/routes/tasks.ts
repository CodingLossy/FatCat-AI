// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 定时任务的 REST(ADR 0033 第 7 节):都需要登录并按 ownerId 取数据,别人的任务一律 404。
// PR 2 只有内置系统任务;用户自建任务的 POST /tasks 随 PR 3(动作与输出)加入。
import { createRoute, z } from '@hono/zod-openapi';
import {
    effectiveTimeZone,
    Id,
    PageQuery,
    Task,
    TaskPage,
    TaskPatch,
    TaskRun,
    TaskRunPage,
    TaskSchedulePreview,
    type Task as TaskDto,
    type TaskRun as TaskRunDto,
} from '@fatcat-ai/shared';
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

export function toTaskRun(run: TaskRunRecord): TaskRunDto {
    return { ...run, trigger: run.trigger, startedAt: run.startedAt, finishedAt: run.finishedAt };
}

export function taskRoutes(deps: { repos: Repositories; scheduler: Scheduler }) {
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
            policy: task.policy,
            nextRunAt: next ? next.toISOString() : null,
            lastRun: last ? toTaskRun(last) : null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
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
        .openapi(getRoute, (c) => c.json(toTask(taskOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const task = taskOr404(ownerId, c.req.valid('param').id);
            const body = c.req.valid('json');
            if (task.kind === 'system' && body.name !== undefined) {
                throw new ApiError(400, 'validation_failed', 'Bad Request', 'System tasks cannot be renamed.');
            }
            if (body.trigger) {
                if (task.kind === 'system' && body.trigger.kind !== 'cron') {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'System tasks use cron triggers.');
                }
                if (body.trigger.kind === 'cron') {
                    const error = validateCron(body.trigger.expression, timeZoneOf(ownerId));
                    if (error) {
                        throw new ApiError(400, 'validation_failed', 'Bad Request', error, {
                            issues: [{ path: ['trigger', 'expression'], message: error }],
                        });
                    }
                } else if (!nextTriggerTime(body.trigger, timeZoneOf(ownerId), new Date())) {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'The time is in the past.', {
                        issues: [{ path: ['trigger', 'at'], message: 'must be in the future' }],
                    });
                }
            }
            const updated = repos.tasks.update(ownerId, task.id, {
                ...body,
                // 重新启用已完成的一次性任务没有意义;改了触发器的任务回到 active
                ...(body.trigger && task.status === 'completed' ? { status: 'active' as const } : {}),
            })!;
            scheduler.engine.rescheduleAll();
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
            return c.body(null, 204);
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

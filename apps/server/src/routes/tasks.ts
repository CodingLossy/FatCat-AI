// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 定时任务的 REST(ADR 0033 第 7 节):都需要登录并按 ownerId 取数据,别人的任务一律 404。
// PR 2 只有内置系统任务;用户自建任务的 POST /tasks 随 PR 3(动作与输出)加入。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRoute, z } from '@hono/zod-openapi';
import {
    type PluginTaskTemplate,
    effectiveTimeZone,
    Id,
    PageQuery,
    parseDomainScope,
    Task,
    TaskConfirm,
    TaskCreate,
    TaskDraftResult,
    TaskFromPluginTemplate,
    TaskPropose,
    TaskPage,
    TaskPatch,
    TaskRun,
    TaskRunPage,
    TaskSchedulePreview,
    TaskWebhookToken,
    toolInSet,
    type Task as TaskDto,
    type TaskDraftNote,
    type TaskRun as TaskRunDto,
} from '@fatcat-ai/shared';
import { isPreauthorizable, type ToolRegistry } from '@fatcat-ai/tools';
import type { Repositories, TaskRecord, TaskRunRecord } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import type { Scheduler } from '../scheduler-setup.js';
import { cronProblem, nextTriggerTime, previewCron } from '../scheduler/time.js';
import { parseDraft, parserPrompt, type TaskComplete } from '../scheduler/nl-parse.js';
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
const proposeRoute = createRoute({
    method: 'post',
    path: '/tasks/propose',
    tags,
    summary: 'Turn one sentence into a task draft. A draft never runs until it is confirmed in the Web UI',
    request: { body: { content: { 'application/json': { schema: TaskPropose } }, required: true } },
    responses: { 201: json(TaskDraftResult, 'Draft'), 400: problem('Not understood'), ...authErrors },
});
const fromPluginRoute = createRoute({
    method: 'post',
    path: '/tasks/from-plugin-template',
    tags,
    summary:
        'Create a task draft from a task template of an enabled plugin. A draft never runs until it is confirmed in the Web UI',
    request: { body: { content: { 'application/json': { schema: TaskFromPluginTemplate } }, required: true } },
    responses: { 201: json(TaskDraftResult, 'Draft'), 404: problem('No such template'), ...authErrors },
});
const confirmRoute = createRoute({
    method: 'post',
    path: '/tasks/{id}/confirm',
    tags,
    summary:
        'Confirm a draft so it takes effect. Needs a logged-in session (not an access token) and the draft version',
    request: { params: idParam, body: { content: { 'application/json': { schema: TaskConfirm } }, required: true } },
    responses: {
        200: json(Task, 'Active task'),
        404: problem('Not found'),
        409: problem('The draft changed or is not a draft'),
        ...authErrors,
    },
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

/** cron 问题码 → 给客户端本地化用的稳定原因码。 */
const cronReason = (code: 'fields' | 'never' | 'interval' | 'invalid') =>
    code === 'invalid' ? 'task_cron_invalid' : `task_cron_${code}`;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function toTaskRun(run: TaskRunRecord): TaskRunDto {
    return { ...run };
}

/** 在运行记录上补上「等待批准」:运行中且任务会话里有待批审批时,给出数量与最早的过期时刻。 */
function withApproval(repos: Repositories, ownerId: string, run: TaskRunRecord): TaskRunDto {
    const dto = toTaskRun(run);
    if (run.status !== 'running' || !run.sessionId) return dto;
    const agentRun = repos.runs.activeInSession(ownerId, run.sessionId);
    // 委派出去的子运行的待批审批也算在任务运行头上(ADR 0042 第 3 节)
    const pending = agentRun
        ? repos.runs
              .listTree(ownerId, agentRun.id)
              .flatMap((r) => repos.approvals.listByRun(ownerId, r.id))
              .filter((a) => a.status === 'pending')
        : [];
    if (pending.length === 0) return dto;
    const expiresAt = pending.map((a) => a.expiresAt).sort()[0]!;
    return { ...dto, waitingApproval: { count: pending.length, expiresAt } };
}

const DRAFT_TTL_MS = 7 * 24 * 3600_000;

export function taskRoutes(deps: {
    repos: Repositories;
    scheduler: Scheduler;
    tools?: ToolRegistry | undefined;
    complete?: TaskComplete | undefined;
    /** 已启用插件的任务模板;找不到时抛 404。 */
    pluginTemplate?: (
        ownerId: string,
        pluginId: string,
        index: number,
    ) => { name: string; template: PluginTaskTemplate };
}) {
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
        const trigger = task.trigger;
        const root =
            trigger.kind === 'file_changed'
                ? repos.fsRoots.list(task.ownerId).find((r) => r.id === trigger.rootId)
                : undefined;
        const rootGone = trigger.kind === 'file_changed' && !root;
        const rootMissing = root !== undefined && !existsSync(root.path);
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
            disabledReason: task.disabledReason === 'plugin_removed' ? 'plugin_removed' : null,
            warning: rootGone ? 'root_revoked' : rootMissing ? 'root_missing' : null,
            timeZone: timeZoneOf(task.ownerId),
            nextRunAt: next ? next.toISOString() : null,
            lastRun: last ? withApproval(repos, task.ownerId, last) : null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    };
    const invalid = (message: string, path: (string | number)[], reason?: string) =>
        new ApiError(400, 'validation_failed', 'Bad Request', message, {
            issues: [{ path, message }],
            ...(reason ? { reason } : {}),
        });
    /** 没有 issues 的业务错误;`reason` 是给客户端本地化用的稳定码。 */
    const fail = (
        status: 400 | 409 | 403,
        code: 'validation_failed' | 'conflict' | 'forbidden',
        message: string,
        reason: string,
    ) =>
        new ApiError(
            status,
            code,
            status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Conflict',
            message,
            { reason },
        );
    /** 工具集的一项必须是已注册的工具名,或以 `.` 结尾且至少匹配一个已注册工具的前缀。 */
    const toolSetEntryKnown = (entry: string): boolean =>
        (deps.tools?.info() ?? []).some((tool) => toolInSet(tool.name, [entry]));
    /** 输出与白名单的校验(ADR 0034 第 3 节):渠道必须属于主人;白名单只能是存在且可预授权的工具。 */
    const checkOutputsAndPolicy = (
        ownerId: string,
        outputs: TaskDto['outputs'] | undefined,
        policy: TaskDto['policy'] | undefined,
    ) => {
        outputs?.forEach((output, i) => {
            if (output.kind === 'channel' && !repos.channels.get(ownerId, output.channelId)) {
                throw invalid('The channel does not exist.', ['outputs', i, 'channelId'], 'task_channel_missing');
            }
        });
        policy?.toolSet?.forEach((entry, i) => {
            if (!toolSetEntryKnown(entry)) {
                throw invalid('Unknown tool or prefix.', ['policy', 'toolSet', i], 'task_toolset_unknown');
            }
        });
        policy?.allowedTools?.forEach((entry, i) => {
            // 预授权的工具不在工具集内就永远用不上:拒绝,免得用户以为它生效了
            if (policy.toolSet && !toolInSet(entry.tool, policy.toolSet)) {
                throw invalid(
                    `${entry.tool} is not in the task's tool set, so this pre-authorization could never be used.`,
                    ['policy', 'allowedTools', i, 'tool'],
                    'task_preauth_outside_toolset',
                );
            }
            const tool = deps.tools?.get(entry.tool);
            if (!tool) throw invalid('Unknown tool.', ['policy', 'allowedTools', i, 'tool'], 'task_tool_unknown');
            if (!isPreauthorizable(tool)) {
                throw invalid(
                    `${tool.name} sends or runs things outside this machine and always needs approval; it cannot be allow-listed.`,
                    ['policy', 'allowedTools', i, 'tool'],
                    'task_tool_not_allowed',
                );
            }
            // 必须带约束的工具(web.fetch 要带域名)不带约束就等于放行所有目标:拒绝
            if (tool.requireConstraint && !entry.constraint?.[tool.requireConstraint]) {
                throw invalid(
                    `${tool.name} can only be allow-listed with a ${tool.requireConstraint} constraint.`,
                    ['policy', 'allowedTools', i, 'constraint'],
                    'task_tool_constraint_required',
                );
            }
            const domain = entry.constraint?.domain;
            if (domain !== undefined) {
                const parsed = parseDomainScope(domain);
                if ('problem' in parsed) {
                    const codes = {
                        empty: 'task_tool_constraint_required',
                        protocol: 'task_domain_protocol',
                        path: 'task_domain_path',
                        port: 'task_domain_port',
                        broad: 'task_domain_broad',
                        invalid: 'task_domain_invalid',
                    } as const;
                    throw invalid(
                        `Invalid domain "${domain}" (${parsed.problem}).`,
                        ['policy', 'allowedTools', i, 'constraint', 'domain'],
                        codes[parsed.problem],
                    );
                }
                // 存规范值(小写、去末尾的点),运行时按它匹配
                entry.constraint = { ...entry.constraint, domain: parsed.ok };
            }
        });
    };
    /** 触发器的校验:cron / 一次性 / 事件触发器引用的账户与目录必须属于主人。 */
    const checkTrigger = (ownerId: string, trigger: TaskDto['trigger']) => {
        const timeZone = timeZoneOf(ownerId);
        if (trigger.kind === 'cron') {
            const problem = cronProblem(trigger.expression, timeZone);
            if (problem) throw invalid(problem.message, ['trigger', 'expression'], cronReason(problem.code));
        } else if (trigger.kind === 'once') {
            if (!nextTriggerTime(trigger, timeZone, new Date()))
                throw invalid('The time is in the past.', ['trigger', 'at'], 'task_time_past');
        } else if (trigger.kind === 'mail_received') {
            if (trigger.accountId && !repos.mail.get(ownerId, trigger.accountId)) {
                throw invalid(
                    'The mail account does not exist.',
                    ['trigger', 'accountId'],
                    'task_mail_account_missing',
                );
            }
        } else if (trigger.kind === 'file_changed') {
            if (!repos.fsRoots.list(ownerId).some((r) => r.id === trigger.rootId)) {
                throw invalid(
                    'The directory is not an authorized directory.',
                    ['trigger', 'rootId'],
                    'task_root_unauthorized',
                );
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
            const problem = cronProblem(expression, timeZone);
            if (problem) throw invalid(problem.message, ['expression'], cronReason(problem.code));
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
        .openapi(proposeRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { text } = c.req.valid('json');
            if (!deps.complete) throw fail(400, 'validation_failed', 'No model is configured.', 'task_no_model');
            const timeZone = timeZoneOf(ownerId);
            let raw: string;
            try {
                raw = await deps.complete(
                    ownerId,
                    parserPrompt(
                        timeZone,
                        new Date(),
                        (deps.tools?.info() ?? []).map((tool) => tool.name),
                    ),
                    text,
                    c.req.raw.signal,
                );
            } catch {
                throw fail(400, 'validation_failed', 'The model could not be reached.', 'task_model_unreachable');
            }
            const parsed = parseDraft(raw);
            if (!parsed.ok) {
                // 固定的几句提示,不回显模型的原文
                if (parsed.reason === 'not_json' || parsed.reason === 'invalid') {
                    throw fail(
                        400,
                        'validation_failed',
                        'I could not understand that. Please say when it should run and what it should do.',
                        'task_not_understood',
                    );
                }
                throw fail(
                    400,
                    'validation_failed',
                    'Something is missing, for example the time or what to do. Please add it and try again.',
                    'task_missing_info',
                );
            }
            const { task: p } = parsed;
            let trigger: TaskDto['trigger'];
            if (p.trigger.kind === 'once') {
                const at = Date.parse(p.trigger.at);
                if (Number.isNaN(at))
                    throw invalid('The time is not understood.', ['trigger', 'at'], 'task_time_unclear');
                trigger = { kind: 'once', at: new Date(at).toISOString() };
            } else trigger = p.trigger;
            checkTrigger(ownerId, trigger);
            const warnings: string[] = [];
            const notes: TaskDraftNote[] = [];
            const outputs: TaskDto['outputs'] = [{ kind: 'conversation' }];
            if (p.push) {
                const channel = repos.channels.list(ownerId).find((ch) => ch.enabled && ch.binding);
                if (channel) {
                    outputs[0] = { kind: 'channel', channelId: channel.id };
                    warnings.push(
                        `The result will be pushed to the channel "${channel.label}" (each push needs your approval).`,
                    );
                    notes.push({ code: 'push_channel', channel: channel.label });
                } else {
                    warnings.push('No bound channel is available, so the result stays in the task conversation.');
                    notes.push({ code: 'no_channel' });
                }
            }
            if (trigger.kind === 'mail_received') {
                warnings.push(
                    'This trigger only provides the number of new messages, not their sender, subject or content.',
                );
                notes.push({ code: 'mail_count_only' });
            }
            const suggested = [...new Set(p.toolSet ?? [])].filter(toolSetEntryKnown);
            // 解析器只给出这几项(含建议的工具集);策略一律取默认值,白名单为空
            const policy = {
                maxAttempts: 3,
                misfire: trigger.kind === 'once' ? ('catchUp' as const) : ('skip' as const),
                quietHours: null,
                maxRuntimeMinutes: 10,
                // 模型给的工具集只是建议:去掉不存在的名字与重复项,用户在确认卡上改
                ...(suggested.length > 0 ? { toolSet: suggested } : {}),
            };
            repos.tasks.pruneDrafts(new Date(Date.now() - DRAFT_TTL_MS).toISOString());
            const draft = repos.tasks.createUser(
                ownerId,
                { name: p.name, trigger, action: { kind: 'agent_prompt', prompt: p.prompt }, outputs, policy },
                true,
            );
            return c.json({ task: toTask(draft), warnings, notes, timeZone }, 201);
        })
        .openapi(fromPluginRoute, (c) => {
            const ownerId = requireOwner(c);
            const { pluginId, index } = c.req.valid('json');
            if (!deps.pluginTemplate) throw notFound('Task template');
            const { name, template } = deps.pluginTemplate(ownerId, pluginId, index);
            const timeZone = timeZoneOf(ownerId);
            const locale = repos.settings.get(ownerId).locale;
            const title =
                (locale === 'en' ? template.title.en : template.title['zh-CN']) ??
                template.title.en ??
                template.title['zh-CN'] ??
                pluginId;
            checkTrigger(ownerId, template.trigger);
            repos.tasks.pruneDrafts(new Date(Date.now() - DRAFT_TTL_MS).toISOString());
            const draft = repos.tasks.createUser(
                ownerId,
                {
                    name: title.slice(0, 80),
                    trigger: template.trigger,
                    action: { kind: 'agent_prompt', prompt: template.prompt },
                    outputs: [{ kind: 'conversation' }],
                    policy: {
                        maxAttempts: 3,
                        misfire: 'skip',
                        quietHours: null,
                        maxRuntimeMinutes: 10,
                        fromPlugin: pluginId,
                    },
                },
                true,
            );
            return c.json(
                {
                    task: toTask(draft),
                    warnings: [
                        `This draft comes from the task template of the plugin "${name}". Nothing runs until you confirm it.`,
                    ],
                    timeZone,
                },
                201,
            );
        })
        .openapi(confirmRoute, (c) => {
            const auth = c.get('auth');
            const ownerId = requireOwner(c);
            if (auth?.kind !== 'session') {
                throw fail(
                    403,
                    'forbidden',
                    'Confirming a task needs a logged-in session.',
                    'task_confirm_needs_session',
                );
            }
            const task = taskOr404(ownerId, c.req.valid('param').id);
            if (task.status !== 'draft') throw fail(409, 'conflict', 'The task is not a draft.', 'task_not_draft');
            if (task.updatedAt !== c.req.valid('json').version) {
                throw fail(409, 'conflict', 'The draft changed after it was shown.', 'task_draft_changed');
            }
            // 确认时再校验一遍(草稿期间渠道或目录可能已被删除;一次性时刻可能已过)
            checkTrigger(ownerId, task.trigger);
            checkOutputsAndPolicy(ownerId, task.outputs, task.policy);
            const active = repos.tasks.update(ownerId, task.id, { status: 'active', enabled: true })!;
            scheduler.engine.rescheduleAll();
            scheduler.syncWatchers();
            return c.json(toTask(active), 200);
        })
        .openapi(getRoute, (c) => c.json(toTask(taskOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const task = taskOr404(ownerId, c.req.valid('param').id);
            const body = c.req.valid('json');
            if (task.kind === 'system' && body.name !== undefined) {
                throw fail(400, 'validation_failed', 'System tasks cannot be renamed.', 'task_system_rename');
            }
            if (task.kind === 'system' && (body.action || body.outputs)) {
                throw invalid(
                    'System tasks cannot change their action or outputs.',
                    [body.action ? 'action' : 'outputs'],
                    'task_system_action',
                );
            }
            if (task.status === 'draft' && body.enabled === true) {
                throw fail(409, 'conflict', 'A draft must be confirmed before it can be enabled.', 'task_draft_enable');
            }
            checkOutputsAndPolicy(ownerId, body.outputs, body.policy);
            if (body.trigger) {
                if (task.kind === 'system' && body.trigger.kind !== 'cron') {
                    throw invalid('System tasks use cron triggers.', ['trigger'], 'task_system_trigger');
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
                throw fail(
                    409,
                    'conflict',
                    'System tasks cannot be deleted; disable them instead.',
                    'task_system_delete',
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
                throw fail(409, 'conflict', 'The task does not use a webhook trigger.', 'task_not_webhook');
            }
            const token = `fcwh_${randomBytes(24).toString('base64url')}`;
            repos.tasks.setWebhookTokenHash(task.id, hashToken(token));
            return c.json({ token, url: `/hooks/${task.id}` }, 201);
        })
        .openapi(runRoute, (c) => {
            const task = taskOr404(requireOwner(c), c.req.valid('param').id);
            if (task.status === 'draft') throw fail(409, 'conflict', 'Confirm the draft first.', 'task_run_draft');
            const run = scheduler.engine.runNow(task.id);
            if (!run) throw fail(409, 'conflict', 'The task is already queued or running.', 'task_run_busy');
            return c.json(toTaskRun(run), 202);
        })
        .openapi(runsRoute, (c) => {
            const ownerId = requireOwner(c);
            const task = taskOr404(ownerId, c.req.valid('param').id);
            const { cursor, limit } = c.req.valid('query');
            const page = repos.tasks.listRuns(task.id, { cursor, limit });
            return c.json(
                { items: page.items.map((r) => withApproval(repos, ownerId, r)), nextCursor: page.nextCursor },
                200,
            );
        })
        .openapi(runGetRoute, (c) => {
            const ownerId = requireOwner(c);
            return c.json(withApproval(repos, ownerId, runOr404(ownerId, c.req.valid('param').id)), 200);
        })
        .openapi(cancelRoute, (c) => {
            const run = runOr404(requireOwner(c), c.req.valid('param').id);
            if (!scheduler.engine.cancel(run.id)) {
                throw fail(409, 'conflict', 'The run has already finished.', 'task_run_finished');
            }
            return c.json(toTaskRun(repos.tasks.getRun(run.id) ?? run), 200);
        });
}

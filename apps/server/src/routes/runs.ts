// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { EventEnvelope, Id, Run, RunTree } from '@fatcat-ai/shared';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { resumeFrom, streamRunEvents } from '../sse.js';
import { loadRunAgent } from './agents.js';
import { authErrors, json, problem, router } from './common.js';
import { resolveProfile, runResponses, type SessionRouteDeps, startAndRespond } from './sessions.js';

const runParam = z.object({ id: Id });

const getRoute = createRoute({
    method: 'get',
    path: '/runs/{id}',
    tags: ['runs'],
    summary: 'Get a run',
    request: { params: runParam },
    responses: { 200: json(Run, 'Run'), 404: problem('Not found'), ...authErrors },
});

const treeRoute = createRoute({
    method: 'get',
    path: '/runs/{id}/tree',
    tags: ['runs'],
    summary: 'The delegation tree below a run: the run itself and every sub-run it delegated, in start order',
    request: { params: runParam },
    responses: { 200: json(RunTree, 'Delegation tree'), 404: problem('Not found'), ...authErrors },
});

const eventsRoute = createRoute({
    method: 'get',
    path: '/runs/{id}/events',
    tags: ['runs'],
    summary: 'Resume the event stream of a run after Last-Event-ID (or ?after=seq), then follow it live',
    request: {
        params: runParam,
        query: z.object({ after: z.string().regex(/^\d+$/).optional() }),
        headers: z.object({ 'last-event-id': z.string().optional() }),
    },
    responses: {
        200: {
            content: { 'text/event-stream': { schema: EventEnvelope } },
            description: 'Server-sent events until run-finished or run-failed',
        },
        404: problem('Not found'),
        ...authErrors,
    },
});

const cancelRoute = createRoute({
    method: 'post',
    path: '/runs/{id}/cancel',
    tags: ['runs'],
    summary: 'Cancel an active run',
    request: { params: runParam },
    responses: {
        202: json(z.object({ cancelled: z.literal(true) }), 'Cancellation requested'),
        404: problem('Not found'),
        409: problem('The run is not active'),
        ...authErrors,
    },
});

const retryRoute = createRoute({
    method: 'post',
    path: '/runs/{id}/retry',
    tags: ['runs'],
    summary: 'Retry a failed or cancelled run with the same input',
    request: { params: runParam, query: z.object({ stream: z.enum(['true', 'false']).optional() }) },
    responses: runResponses,
});

export function runRoutes(deps: SessionRouteDeps) {
    const { repos, runs } = deps;
    const runOr404 = (ownerId: string, id: string) => {
        const run = repos.runs.get(ownerId, id);
        if (!run) throw notFound('Run');
        return run;
    };

    return router()
        .openapi(getRoute, (c) => c.json(runOr404(requireOwner(c), c.req.valid('param').id), 200))
        .openapi(treeRoute, (c) => {
            const ownerId = requireOwner(c);
            const root = runOr404(ownerId, c.req.valid('param').id);
            const tree = repos.runs.listTree(ownerId, root.id);
            const depthOf = new Map<string, number>([[root.id, 0]]);
            const names = new Map<string, string | null>();
            const nameOf = (agentId: string) => {
                if (!names.has(agentId)) names.set(agentId, repos.agents.get(ownerId, agentId)?.name ?? null);
                return names.get(agentId) ?? null;
            };
            const nodes = tree.map((r) => {
                const depth = r.parentRunId ? (depthOf.get(r.parentRunId) ?? 0) + 1 : 0;
                depthOf.set(r.id, depth);
                return {
                    runId: r.id,
                    parentRunId: r.id === root.id ? null : (r.parentRunId ?? null),
                    agentId: r.agentId ?? null,
                    agentName: r.agentId ? nameOf(r.agentId) : null,
                    status: r.status,
                    startedAt: r.startedAt,
                    finishedAt: r.finishedAt,
                    depth,
                };
            });
            return c.json({ rootRunId: root.id, nodes }, 200);
        })
        .openapi(eventsRoute, (c) => {
            const ownerId = requireOwner(c);
            const run = runOr404(ownerId, c.req.valid('param').id);
            return streamRunEvents(c, deps, ownerId, run.id, resumeFrom(c));
        })
        .openapi(cancelRoute, (c) => {
            const ownerId = requireOwner(c);
            const found = runOr404(ownerId, c.req.valid('param').id);
            // 子运行没有自己的控制器:取消它所在的整棵委派树,即取消根运行
            const run = repos.runs.rootOf(ownerId, found.id) ?? found;
            if (!runs.cancel(run.id)) {
                throw new ApiError(409, 'run_not_active', 'Conflict', 'The run has already finished.');
            }
            return c.json({ cancelled: true as const }, 202);
        })
        .openapi(retryRoute, (c) => {
            const ownerId = requireOwner(c);
            const run = runOr404(ownerId, c.req.valid('param').id);
            if (run.parentRunId) {
                throw new ApiError(
                    409,
                    'conflict',
                    'Conflict',
                    'This run was delegated by another run. Retry the run that started it.',
                    { reason: 'run_is_delegated' },
                );
            }
            if (run.status !== 'failed' && run.status !== 'cancelled') {
                throw new ApiError(409, 'conflict', 'Conflict', 'Only failed or cancelled runs can be retried.');
            }
            const session = repos.sessions.get(ownerId, run.sessionId);
            if (!session) throw notFound('Session');
            const agent =
                run.agentId && repos.agents.get(ownerId, run.agentId)
                    ? loadRunAgent(repos, ownerId, run.agentId)
                    : null;
            const profile = resolveProfile(deps, ownerId, agent?.record.modelProfileId, session.modelProfileId);
            return startAndRespond(
                c,
                deps,
                () =>
                    runs.start({
                        ownerId,
                        sessionId: session.id,
                        profile,
                        ...(agent ? { agent: agent.runAgent } : {}),
                        inputMessageId: run.inputMessageId,
                        ...(run.outputMessageId ? { replacesMessageId: run.outputMessageId } : {}),
                    }),
                c.req.valid('query').stream !== 'false',
            );
        });
}

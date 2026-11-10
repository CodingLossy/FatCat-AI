// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { EventEnvelope, Id, Run } from '@fatcat-ai/shared';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { resumeFrom, streamRunEvents } from '../sse.js';
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
        .openapi(eventsRoute, (c) => {
            const ownerId = requireOwner(c);
            const run = runOr404(ownerId, c.req.valid('param').id);
            return streamRunEvents(c, deps, ownerId, run.id, resumeFrom(c));
        })
        .openapi(cancelRoute, (c) => {
            const run = runOr404(requireOwner(c), c.req.valid('param').id);
            if (!runs.cancel(run.id)) {
                throw new ApiError(409, 'run_not_active', 'Conflict', 'The run has already finished.');
            }
            return c.json({ cancelled: true as const }, 202);
        })
        .openapi(retryRoute, (c) => {
            const ownerId = requireOwner(c);
            const run = runOr404(ownerId, c.req.valid('param').id);
            if (run.status !== 'failed' && run.status !== 'cancelled') {
                throw new ApiError(409, 'conflict', 'Conflict', 'Only failed or cancelled runs can be retried.');
            }
            const session = repos.sessions.get(ownerId, run.sessionId);
            if (!session) throw notFound('Session');
            const profile = resolveProfile(deps, ownerId, null, session.modelProfileId);
            return startAndRespond(
                c,
                deps,
                () =>
                    runs.start({
                        ownerId,
                        sessionId: session.id,
                        profile,
                        inputMessageId: run.inputMessageId,
                        ...(run.outputMessageId ? { replacesMessageId: run.outputMessageId } : {}),
                    }),
                c.req.valid('query').stream !== 'false',
            );
        });
}

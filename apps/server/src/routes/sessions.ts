// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { RunConflictError, type RunManager } from '@fatcat-ai/agent';
import { type SecretStore, selectProfile } from '@fatcat-ai/providers';
import {
    CreateSessionRequest,
    EventEnvelope,
    Id,
    Message,
    PageQuery,
    pageOf,
    SendMessageAccepted,
    SendMessageRequest,
    Session,
    UpdateSessionRequest,
} from '@fatcat-ai/shared';
import type { ModelProfileRecord, Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import { requireOwner } from '../auth/middleware.js';
import type { AppEnv } from '../env.js';
import { ApiError, notFound } from '../errors.js';
import { streamRunEvents, type RunStreamDeps } from '../sse.js';
import { authErrors, json, problem, router } from './common.js';

export interface SessionRouteDeps extends RunStreamDeps {
    repos: Repositories;
    runs: RunManager;
    secrets: SecretStore;
}

const sessionParam = z.object({ id: Id });
const streamQuery = z.object({
    stream: z.enum(['true', 'false']).optional().openapi({ description: 'false: return 202 instead of an SSE stream' }),
});

/** 发送消息 / 重新生成 / 重试的响应:默认 SSE,stream=false 时返回 202。 */
export const runResponses = {
    200: {
        content: { 'text/event-stream': { schema: EventEnvelope } },
        description: 'Server-sent events (event: agent, id: seq) until run-finished or run-failed',
    },
    202: json(SendMessageAccepted, 'Run started (stream=false)'),
    404: problem('Not found'),
    409: problem('Another run is active, or no usable model profile'),
    ...authErrors,
};

/** 选择运行用的模型配置档:请求指定 > 会话设置 > 设置中的默认 chat 配置档 > 第一个 chat 配置档(ADR 0006)。 */
export function resolveProfile(
    deps: SessionRouteDeps,
    ownerId: string,
    requested: string | null | undefined,
    sessionProfileId: string | null,
): ModelProfileRecord {
    const profiles = deps.repos.modelProfiles.list(ownerId);
    const wanted = requested ?? sessionProfileId;
    const defaults = { chat: deps.repos.settings.get(ownerId).defaultChatProfileId };
    const profile = wanted
        ? (profiles.find((p) => p.id === wanted) ?? null)
        : selectProfile(profiles, 'chat', defaults);
    if (!profile) {
        throw new ApiError(
            409,
            'model_profile_missing',
            'Conflict',
            wanted ? 'The selected model profile does not exist.' : 'Create a model profile first.',
        );
    }
    if (deps.secrets.status(profile.apiKeyRef) === 'missing') {
        throw new ApiError(
            409,
            'model_key_missing',
            'Conflict',
            `The key referenced by ${profile.apiKeyRef ?? ''} is not set.`,
        );
    }
    return profile;
}

/** 启动运行并按 stream 参数返回 SSE 或 202;同一会话已有运行时返回 409。 */
export function startAndRespond(
    c: Context<AppEnv>,
    deps: SessionRouteDeps,
    start: () => { runId: string; userMessageId: string; assistantMessageId: string },
    stream: boolean,
): Response {
    let started;
    try {
        started = start();
    } catch (error) {
        if (error instanceof RunConflictError) {
            throw new ApiError(
                409,
                'conflict',
                'Conflict',
                `Run ${error.activeRunId} is still active in this session.`,
            );
        }
        throw error;
    }
    if (!stream) return c.json(started, 202);
    return streamRunEvents(c, deps, requireOwner(c), started.runId, 0);
}

const listRoute = createRoute({
    method: 'get',
    path: '/sessions',
    tags: ['sessions'],
    summary: 'List sessions, most recently updated first',
    request: { query: PageQuery },
    responses: { 200: json(pageOf(Session), 'Sessions'), 400: problem('Invalid cursor'), ...authErrors },
});

const createSessionRoute = createRoute({
    method: 'post',
    path: '/sessions',
    tags: ['sessions'],
    summary: 'Create a session',
    request: { body: { content: { 'application/json': { schema: CreateSessionRequest } }, required: false } },
    responses: { 201: json(Session, 'Created'), 400: problem('Invalid request'), ...authErrors },
});

const getRoute = createRoute({
    method: 'get',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Get a session',
    request: { params: sessionParam },
    responses: { 200: json(Session, 'Session'), 404: problem('Not found'), ...authErrors },
});

const patchRoute = createRoute({
    method: 'patch',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Rename a session or change its model profile',
    request: {
        params: sessionParam,
        body: { content: { 'application/json': { schema: UpdateSessionRequest } }, required: true },
    },
    responses: {
        200: json(Session, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Delete a session with its messages, runs and events (an active run is cancelled first)',
    request: { params: sessionParam },
    responses: { 204: { description: 'Deleted' }, 404: problem('Not found'), ...authErrors },
});

const messagesRoute = createRoute({
    method: 'get',
    path: '/sessions/{id}/messages',
    tags: ['sessions'],
    summary: 'List messages in order',
    request: { params: sessionParam, query: PageQuery },
    responses: { 200: json(pageOf(Message), 'Messages'), 404: problem('Not found'), ...authErrors },
});

const sendRoute = createRoute({
    method: 'post',
    path: '/sessions/{id}/messages',
    tags: ['sessions'],
    summary: 'Send a user message and start a run',
    request: {
        params: sessionParam,
        query: streamQuery,
        body: { content: { 'application/json': { schema: SendMessageRequest } }, required: true },
    },
    responses: { ...runResponses, 400: problem('Invalid request') },
});

const regenerateRoute = createRoute({
    method: 'post',
    path: '/sessions/{id}/messages/{messageId}/regenerate',
    tags: ['sessions'],
    summary: 'Regenerate an assistant reply; the old reply is kept as a branch',
    request: { params: sessionParam.extend({ messageId: Id }), query: streamQuery },
    responses: runResponses,
});

export function sessionRoutes(deps: SessionRouteDeps) {
    const { repos, runs } = deps;

    const sessionOr404 = (ownerId: string, id: string) => {
        const session = repos.sessions.get(ownerId, id);
        if (!session) throw notFound('Session');
        return session;
    };
    const checkProfile = (ownerId: string, id: string | null | undefined) => {
        if (id && !repos.modelProfiles.get(ownerId, id)) {
            throw new ApiError(400, 'validation_failed', 'Bad Request', 'The model profile does not exist.', {
                issues: [{ path: ['modelProfileId'], message: 'unknown model profile' }],
            });
        }
    };

    return router()
        .openapi(listRoute, (c) => c.json(repos.sessions.list(requireOwner(c), c.req.valid('query')), 200))
        .openapi(createSessionRoute, (c) => {
            const ownerId = requireOwner(c);
            const body: CreateSessionRequest = (c.req.valid('json') as CreateSessionRequest | undefined) ?? {};
            checkProfile(ownerId, body.modelProfileId);
            return c.json(repos.sessions.create(ownerId, body), 201);
        })
        .openapi(getRoute, (c) => c.json(sessionOr404(requireOwner(c), c.req.valid('param').id), 200))
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            sessionOr404(ownerId, id);
            const body = c.req.valid('json');
            checkProfile(ownerId, body.modelProfileId);
            return c.json(repos.sessions.update(ownerId, id, body)!, 200);
        })
        .openapi(deleteRoute, async (c) => {
            const ownerId = requireOwner(c);
            const session = sessionOr404(ownerId, c.req.valid('param').id);
            if (session.activeRunId) await runs.stop(session.activeRunId);
            repos.sessions.delete(ownerId, session.id);
            return c.body(null, 204);
        })
        .openapi(messagesRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            sessionOr404(ownerId, id);
            return c.json(repos.messages.list(ownerId, id, c.req.valid('query')), 200);
        })
        .openapi(sendRoute, (c) => {
            const ownerId = requireOwner(c);
            const session = sessionOr404(ownerId, c.req.valid('param').id);
            const body = c.req.valid('json');
            const stream = c.req.valid('query').stream !== 'false';

            // 幂等:同一 clientMessageId 重复提交时返回已有运行
            if (body.clientMessageId) {
                const existing = repos.messages.findByClientMessageId(session.id, body.clientMessageId);
                const run = existing ? repos.runs.latestForInput(ownerId, existing.id) : null;
                if (existing && run) {
                    const accepted = {
                        runId: run.id,
                        userMessageId: existing.id,
                        assistantMessageId: run.outputMessageId ?? '',
                    };
                    return stream ? streamRunEvents(c, deps, ownerId, run.id, 0) : c.json(accepted, 202);
                }
            }

            const profile = resolveProfile(deps, ownerId, body.modelProfileId, session.modelProfileId);
            return startAndRespond(
                c,
                deps,
                () =>
                    runs.start({
                        ownerId,
                        sessionId: session.id,
                        profile,
                        text: body.text,
                        clientMessageId: body.clientMessageId,
                    }),
                stream,
            );
        })
        .openapi(regenerateRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id, messageId } = c.req.valid('param');
            const session = sessionOr404(ownerId, id);
            const message = repos.messages.get(ownerId, messageId);
            const run = message?.runId ? repos.runs.get(ownerId, message.runId) : null;
            if (!message || message.sessionId !== session.id || message.role !== 'assistant' || !run) {
                throw notFound('Assistant message');
            }
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
                        replacesMessageId: message.id,
                    }),
                c.req.valid('query').stream !== 'false',
            );
        });
}

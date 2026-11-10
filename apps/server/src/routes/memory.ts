// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import type { MemoryStack } from '../memory-setup.js';
import {
    Id,
    ConflictResolveInput,
    Memory,
    MemoryConflict,
    MemoryDigest,
    MemoryFeedbackBody,
    MemoryFeedbackResult,
    MemorySource,
    MemoryWriteResult,
    QuarantinedMemory,
    MemoryPatch,
    MemoryRetrieveInput,
    MemoryRetrieveResult,
    MemorySaveInput,
    MemorySaveResult,
    MemorySearchInput,
    MemorySearchResult,
    pageOf,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const idParam = z.object({ id: Id });

const feedbackRoute = createRoute({
    method: 'post',
    path: '/memory/{id}/feedback',
    tags: ['memory'],
    summary:
        'Feedback on a memory (helpful, stale, wrong with an optional correction, sensitive); takes effect at once',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: MemoryFeedbackBody } }, required: true },
    },
    responses: {
        200: json(MemoryFeedbackResult, 'Applied, duplicate, corrected or deleted'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});

const sourcesRoute = createRoute({
    method: 'get',
    path: '/memory/{id}/sources',
    tags: ['memory'],
    summary: 'Where a memory came from, newest first',
    request: { params: idParam },
    responses: { 200: json(pageOf(MemorySource), 'Sources'), 404: problem('Not found'), ...authErrors },
});

const historyRoute = createRoute({
    method: 'get',
    path: '/memory/{id}/history',
    tags: ['memory'],
    summary: 'The supersede chain of a memory: newer versions first, then this one, then older versions',
    request: { params: idParam },
    responses: { 200: json(pageOf(Memory), 'Versions'), 404: problem('Not found'), ...authErrors },
});

const conflictsRoute = createRoute({
    method: 'get',
    path: '/memory/conflicts',
    tags: ['memory'],
    summary: 'Open memory conflicts',
    responses: { 200: json(pageOf(MemoryConflict), 'Conflicts'), ...authErrors },
});

const resolveRoute = createRoute({
    method: 'post',
    path: '/memory/conflicts/{id}/resolve',
    tags: ['memory'],
    summary: 'Resolve a conflict: keep one, keep both or dismiss',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: ConflictResolveInput } }, required: true },
    },
    responses: {
        204: { description: 'Resolved' },
        404: problem('Not found'),
        409: problem('The conflict is already resolved'),
        ...authErrors,
    },
});

const quarantineRoute = createRoute({
    method: 'get',
    path: '/memory/quarantine',
    tags: ['memory'],
    summary: 'Quarantined memory candidates (redacted, kept for 14 days)',
    responses: { 200: json(pageOf(QuarantinedMemory), 'Quarantine'), ...authErrors },
});

const promoteRoute = createRoute({
    method: 'post',
    path: '/memory/quarantine/{id}/promote',
    tags: ['memory'],
    summary: 'Confirm a quarantined candidate and save it as a memory; credentials are still refused',
    request: { params: idParam },
    responses: {
        200: json(MemoryWriteResult, 'The write result'),
        404: problem('Not found'),
        ...authErrors,
    },
});

const deleteQuery = z.object({
    /** undo:撤销刚写入的记忆(聊天中的「撤销」);其他情况为「忘记」。两者都写审计,只记 id。 */
    reason: z.enum(['undo', 'forget']).default('forget'),
});

const listRoute = createRoute({
    method: 'get',
    path: '/memory',
    tags: ['memory'],
    summary: 'List active memories, most recently updated first',
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: json(pageOf(Memory), 'Memories'), ...authErrors },
});

const saveRoute = createRoute({
    method: 'post',
    path: '/memory',
    tags: ['memory'],
    summary: 'Save a memory written by the user; credentials are refused',
    request: { body: { content: { 'application/json': { schema: MemorySaveInput } }, required: true } },
    responses: {
        200: json(MemorySaveResult, 'created, merged, superseded or refused'),
        400: problem('Invalid request'),
        ...authErrors,
    },
});

const searchRoute = createRoute({
    method: 'post',
    path: '/memory/search',
    tags: ['memory'],
    summary: 'Search memories',
    request: { body: { content: { 'application/json': { schema: MemorySearchInput } }, required: true } },
    responses: { 200: json(MemorySearchResult, 'Matches, best first'), 400: problem('Invalid request'), ...authErrors },
});

const retrieveRoute = createRoute({
    method: 'post',
    path: '/memory/retrieve',
    tags: ['memory'],
    summary: 'Retrieve memories with full-text, vector and graph recall, with trust qualifiers and a rendered block',
    request: { body: { content: { 'application/json': { schema: MemoryRetrieveInput } }, required: true } },
    responses: {
        200: json(MemoryRetrieveResult, 'Ranked memories and the rendered memory block'),
        400: problem('Invalid request'),
        ...authErrors,
    },
});

const digestRoute = createRoute({
    method: 'get',
    path: '/memory/digest',
    tags: ['memory'],
    summary: 'The memory digest injected at the start of each session',
    responses: { 200: json(MemoryDigest, 'Digest'), ...authErrors },
});

const getRoute = createRoute({
    method: 'get',
    path: '/memory/{id}',
    tags: ['memory'],
    summary: 'Get a memory',
    request: { params: idParam },
    responses: { 200: json(Memory, 'Memory'), 404: problem('Not found'), ...authErrors },
});

const patchRoute = createRoute({
    method: 'patch',
    path: '/memory/{id}',
    tags: ['memory'],
    summary: 'Correct the text or domain of a memory, or retract it',
    request: { params: idParam, body: { content: { 'application/json': { schema: MemoryPatch } }, required: true } },
    responses: {
        200: json(Memory, 'Updated'),
        400: problem('Invalid request or the new text looks like a credential'),
        404: problem('Not found'),
        ...authErrors,
    },
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/memory/{id}',
    tags: ['memory'],
    summary: 'Forget a memory permanently, with its sources',
    request: { params: idParam, query: deleteQuery },
    responses: { 204: { description: 'Deleted' }, 404: problem('Not found'), ...authErrors },
});

export interface MemoryRouteDeps {
    repos: Repositories;
    memory: MemoryStack;
    detectCredential: (text: string) => string | null;
}

export function memoryRoutes(deps: MemoryRouteDeps) {
    const { repos } = deps;
    const { memory } = deps.memory;
    return (
        router()
            .openapi(listRoute, (c) =>
                c.json(
                    { items: repos.memories.list(requireOwner(c), c.req.valid('query').limit), nextCursor: null },
                    200,
                ),
            )
            .openapi(saveRoute, (c) => c.json(memory.save(requireOwner(c), c.req.valid('json'), 'user_explicit'), 200))
            .openapi(searchRoute, (c) => c.json(memory.search(requireOwner(c), c.req.valid('json')), 200))
            .openapi(retrieveRoute, async (c) =>
                c.json(await deps.memory.retriever.retrieve(requireOwner(c), c.req.valid('json')), 200),
            )
            .openapi(digestRoute, (c) => c.json(deps.memory.digest.get(requireOwner(c)), 200))
            // 静态路径要在 /memory/{id} 之前注册
            .openapi(conflictsRoute, (c) => {
                const ownerId = requireOwner(c);
                const items = repos.memories.conflicts(ownerId).flatMap((x) => {
                    const a = repos.memories.get(ownerId, x.aId);
                    const b = repos.memories.get(ownerId, x.bId);
                    return a && b ? [{ id: x.id, kind: x.kind, status: x.status, createdAt: x.createdAt, a, b }] : [];
                });
                return c.json({ items, nextCursor: null }, 200);
            })
            .openapi(resolveRoute, (c) => {
                const ownerId = requireOwner(c);
                const outcome = repos.memories.resolveConflict(
                    ownerId,
                    c.req.valid('param').id,
                    c.req.valid('json').resolution,
                );
                if (outcome === 'not_found') throw notFound('Conflict');
                if (outcome === 'not_open') {
                    throw new ApiError(409, 'conflict', 'Conflict', 'The conflict is already resolved.');
                }
                deps.memory.changed(ownerId);
                return c.body(null, 204);
            })
            .openapi(quarantineRoute, (c) =>
                c.json({ items: repos.memories.quarantined(requireOwner(c)), nextCursor: null }, 200),
            )
            .openapi(promoteRoute, (c) => {
                const result = memory.promote(requireOwner(c), c.req.valid('param').id);
                if (!result) throw notFound('Quarantine entry');
                return c.json(result, 200);
            })
            .openapi(feedbackRoute, (c) => {
                const ownerId = requireOwner(c);
                const result = memory.feedback(ownerId, { ...c.req.valid('json'), id: c.req.valid('param').id });
                if (!result) throw notFound('Memory');
                return c.json(result, 200);
            })
            .openapi(sourcesRoute, (c) => {
                const ownerId = requireOwner(c);
                const { id } = c.req.valid('param');
                if (!repos.memories.get(ownerId, id)) throw notFound('Memory');
                return c.json({ items: repos.memories.sources(ownerId, id), nextCursor: null }, 200);
            })
            .openapi(historyRoute, (c) => {
                const items = repos.memories.history(requireOwner(c), c.req.valid('param').id);
                if (!items) throw notFound('Memory');
                return c.json({ items, nextCursor: null }, 200);
            })
            .openapi(getRoute, (c) => {
                const m = repos.memories.get(requireOwner(c), c.req.valid('param').id);
                if (!m) throw notFound('Memory');
                return c.json(m, 200);
            })
            .openapi(patchRoute, (c) => {
                const body = c.req.valid('json');
                if (body.text !== undefined && deps.detectCredential(body.text)) {
                    throw new ApiError(
                        400,
                        'validation_failed',
                        'Bad Request',
                        'Credentials cannot be stored in memory.',
                        {
                            issues: [{ path: ['text'], message: 'looks like a credential' }],
                        },
                    );
                }
                const updated = repos.memories.update(requireOwner(c), c.req.valid('param').id, {
                    ...(body.text !== undefined ? { text: body.text } : {}),
                    ...(body.domain !== undefined ? { domain: body.domain } : {}),
                    retract: body.status === 'retracted',
                });
                if (!updated) throw notFound('Memory');
                deps.memory.changed(
                    requireOwner(c),
                    body.text !== undefined ? { id: updated.id, text: updated.text } : undefined,
                );
                return c.json(updated, 200);
            })
            .openapi(deleteRoute, (c) => {
                const ownerId = requireOwner(c);
                const { id } = c.req.valid('param');
                const { reason } = c.req.valid('query');
                if (!memory.forget(ownerId, id)) throw notFound('Memory');
                c.get('logger').info({ memoryId: id, reason }, 'memory forgotten');
                // 撤销与「忘记」都写审计,只记 id,不记内容(补充设计第 2.2 节)
                repos.audit.append(ownerId, {
                    action: 'memory-undo',
                    toolName: null,
                    risk: null,
                    callId: null,
                    runId: null,
                    sessionId: null,
                    decision: null,
                    outcome: 'ok',
                    summary: reason === 'undo' ? `Undid memory ${id}` : `Forgot memory ${id}`,
                    inputDigest: null,
                    error: null,
                });
                return c.body(null, 204);
            })
    );
}

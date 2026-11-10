// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具、审批、预授权与审计的 REST(ADR 0010)。
import { createRoute, z } from '@hono/zod-openapi';
import type { RunManager } from '@fatcat-ai/agent';
import {
    ApprovalDecision,
    ApprovalQuery,
    ApprovalRequest,
    AuditEntry,
    AuditQuery,
    Id,
    pageOf,
    Preauthorization,
    ToolInfo,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { inputDigest } from '@fatcat-ai/tools';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

export interface ToolRouteDeps {
    repos: Repositories;
    runs: RunManager;
    redact: (text: string) => string;
}

const toolsRoute = createRoute({
    method: 'get',
    path: '/tools',
    tags: ['tools'],
    summary: 'List the tools offered to the model, with their risk and default approval',
    responses: { 200: json(pageOf(ToolInfo), 'Tools'), ...authErrors },
});

const approvalsRoute = createRoute({
    method: 'get',
    path: '/approvals',
    tags: ['tools'],
    summary: 'List approval requests, newest first (status=pending for the approval popup)',
    request: { query: ApprovalQuery },
    responses: {
        200: json(pageOf(ApprovalRequest), 'Approval requests'),
        400: problem('Invalid query'),
        ...authErrors,
    },
});

const approvalRoute = createRoute({
    method: 'post',
    path: '/approvals/{callId}',
    tags: ['runs'],
    summary: 'Approve or reject a pending tool call; approving can also remember the decision',
    request: {
        params: z.object({ callId: Id }),
        body: { content: { 'application/json': { schema: ApprovalDecision } }, required: true },
    },
    responses: {
        200: json(z.object({ callId: Id, decision: ApprovalDecision.shape.decision }), 'Decision recorded'),
        400: problem('Invalid request, or this tool cannot be pre-authorized'),
        409: problem('No pending approval with this id'),
        ...authErrors,
    },
});

const preauthListRoute = createRoute({
    method: 'get',
    path: '/preauthorizations',
    tags: ['tools'],
    summary: 'List saved pre-authorizations',
    responses: { 200: json(pageOf(Preauthorization), 'Pre-authorizations'), ...authErrors },
});

const preauthDeleteRoute = createRoute({
    method: 'delete',
    path: '/preauthorizations/{id}',
    tags: ['tools'],
    summary: 'Revoke a pre-authorization',
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: 'Revoked' }, 404: problem('Not found'), ...authErrors },
});

const auditRoute = createRoute({
    method: 'get',
    path: '/audit',
    tags: ['tools'],
    summary: 'List audit log entries, newest first',
    request: { query: AuditQuery },
    responses: { 200: json(pageOf(AuditEntry), 'Audit log'), 400: problem('Invalid query'), ...authErrors },
});

export function toolRoutes(deps: ToolRouteDeps) {
    const { repos, runs } = deps;
    return router()
        .openapi(toolsRoute, (c) => c.json({ items: runs.tools?.info() ?? [], nextCursor: null }, 200))
        .openapi(approvalsRoute, (c) => c.json(repos.approvals.list(requireOwner(c), c.req.valid('query')), 200))
        .openapi(approvalRoute, (c) => {
            const { callId } = c.req.valid('param');
            const { decision, remember } = c.req.valid('json');
            const outcome = runs.resolveApproval(requireOwner(c), callId, decision, remember);
            if (outcome === 'not_pending') {
                throw new ApiError(
                    409,
                    'approval_not_pending',
                    'Conflict',
                    'There is no pending approval with this id.',
                );
            }
            if (outcome !== 'resolved') {
                throw new ApiError(400, 'validation_failed', 'Bad Request', outcome.invalid, {
                    issues: [{ path: ['remember'], message: outcome.invalid }],
                });
            }
            return c.json({ callId, decision }, 200);
        })
        .openapi(preauthListRoute, (c) =>
            c.json({ items: repos.preauths.list(requireOwner(c)), nextCursor: null }, 200),
        )
        .openapi(preauthDeleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            const existing = repos.preauths.get(ownerId, id);
            if (!existing || !repos.preauths.delete(ownerId, id)) throw notFound('Pre-authorization');
            repos.audit.append(ownerId, {
                action: 'preauth-revoked',
                toolName: existing.toolName,
                risk: runs.tools?.get(existing.toolName)?.risk ?? null,
                callId: null,
                runId: null,
                sessionId: existing.sessionId,
                decision: null,
                outcome: 'ok',
                summary: `Revoked pre-authorization for ${existing.toolName} (${existing.scope})`,
                inputDigest: existing.constraint ? inputDigest(existing.constraint, deps.redact) : null,
                error: null,
            });
            return c.body(null, 204);
        })
        .openapi(auditRoute, (c) => c.json(repos.audit.list(requireOwner(c), c.req.valid('query')), 200));
}

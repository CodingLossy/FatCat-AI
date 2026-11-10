// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 服务器配置的 REST(ADR 0013 第 1 节):只有用户能增删改,没有对应的工具。
import path from 'node:path';
import { createRoute, z } from '@hono/zod-openapi';
import { Id, McpServerInput, McpServerPatch, McpServerStatus, McpServerView, pageOf } from '@ai-personal/shared';
import type { Repositories } from '@ai-personal/storage';
import { inputDigest } from '@ai-personal/tools';
import type { McpControl } from '../mcp-setup.js';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['tools'];
const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/mcp/servers',
    tags,
    summary: 'List configured MCP servers (stdio) with their connection status',
    responses: { 200: json(pageOf(McpServerView), 'MCP servers'), ...authErrors },
});
const createServerRoute = createRoute({
    method: 'post',
    path: '/mcp/servers',
    tags,
    summary: 'Add an MCP server; it is started without a shell and only sees allowed environment variables',
    request: { body: { content: { 'application/json': { schema: McpServerInput } }, required: true } },
    responses: {
        201: json(McpServerView, 'Added; connecting in the background'),
        400: problem('Invalid request'),
        409: problem('A server with this name already exists'),
        ...authErrors,
    },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/mcp/servers/{id}',
    tags,
    summary: 'Enable or disable a server, or change tool risk levels (it reconnects)',
    request: { params: idParam, body: { content: { 'application/json': { schema: McpServerPatch } }, required: true } },
    responses: {
        200: json(McpServerView, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/mcp/servers/{id}',
    tags,
    summary: 'Remove a server; its tools and their pre-authorizations are removed too',
    request: { params: idParam },
    responses: { 204: { description: 'Removed' }, 404: problem('Not found'), ...authErrors },
});
const statusRoute = createRoute({
    method: 'get',
    path: '/mcp/servers/{id}/status',
    tags,
    summary: 'Connection status and registered tools of a server',
    request: { params: idParam },
    responses: { 200: json(McpServerStatus, 'Status'), 404: problem('Not found'), ...authErrors },
});

const pending = (enabled: boolean): McpServerStatus => ({
    state: enabled ? 'connecting' : 'disabled',
    tools: [],
    error: null,
});

export function mcpRoutes(deps: { repos: Repositories; mcp: McpControl; redact: (text: string) => string }) {
    const { repos, mcp } = deps;
    /** 在后台连接;连接结果通过 status 查看。 */
    const connect = (server: Parameters<McpControl['apply']>[0]) => {
        mcp.apply(server).catch(() => undefined);
    };
    return router()
        .openapi(listRoute, (c) =>
            c.json(
                {
                    items: repos.mcpServers.list(requireOwner(c)).map((s) => ({ ...s, status: mcp.status(s.id) })),
                    nextCursor: null,
                },
                200,
            ),
        )
        .openapi(createServerRoute, (c) => {
            const ownerId = requireOwner(c);
            const body = McpServerInput.parse(c.req.valid('json'));
            if (body.cwd && !path.isAbsolute(body.cwd)) {
                throw new ApiError(400, 'validation_failed', 'Bad Request', 'cwd must be an absolute path.', {
                    issues: [{ path: ['cwd'], message: 'must be an absolute path' }],
                });
            }
            if (repos.mcpServers.list(ownerId).some((s) => s.name === body.name)) {
                throw new ApiError(409, 'conflict', 'Conflict', 'An MCP server with this name already exists.');
            }
            const server = repos.mcpServers.create(ownerId, body);
            c.get('logger').info({ mcpServer: server.name }, 'MCP server added');
            connect({ ...server, ownerId });
            return c.json({ ...server, status: pending(server.enabled) }, 201);
        })
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const server = repos.mcpServers.update(ownerId, c.req.valid('param').id, c.req.valid('json'));
            if (!server) throw notFound('MCP server');
            connect({ ...server, ownerId });
            return c.json({ ...server, status: pending(server.enabled) }, 200);
        })
        .openapi(deleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            const server = repos.mcpServers.get(ownerId, id);
            if (!server || !repos.mcpServers.delete(ownerId, id)) throw notFound('MCP server');
            mcp.remove(id);
            // 删除服务器时,它的工具的预授权一并删除(ADR 0010 第 3 节)
            for (const p of repos.preauths.list(ownerId)) {
                if (!p.toolName.startsWith(`mcp.${server.name}.`)) continue;
                repos.preauths.delete(ownerId, p.id);
                repos.audit.append(ownerId, {
                    action: 'preauth-revoked',
                    toolName: p.toolName,
                    risk: 'write',
                    callId: null,
                    runId: null,
                    sessionId: p.sessionId,
                    decision: null,
                    outcome: 'ok',
                    summary: `Revoked pre-authorization for ${p.toolName} because its MCP server was removed`,
                    inputDigest: inputDigest(p.constraint, deps.redact),
                    error: null,
                });
            }
            c.get('logger').info({ mcpServer: server.name }, 'MCP server removed');
            return c.body(null, 204);
        })
        .openapi(statusRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            if (!repos.mcpServers.get(ownerId, id)) throw notFound('MCP server');
            return c.json(mcp.status(id), 200);
        });
}

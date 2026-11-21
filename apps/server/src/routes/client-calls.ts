// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面客户端把客户端执行的调用的结果交回核心(ADR 0046 第 3.6、14 节)。
// 只接受:有会话的所有者、自己名下仍在等待的调用、一次、且在超时之前;其余 404 / 409。
import { createRoute, z } from '@hono/zod-openapi';
import { ClientCallId, ClientCallResult } from '@fatcat-ai/shared';
import { requireOwner } from '../auth/middleware.js';
import type { ClientCalls } from '../client-calls.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, problem, router } from './common.js';

export interface ClientCallRouteDeps {
    calls: ClientCalls;
}

/** 三种结果互斥:文档里保持 oneOf(与截图时代的文档一致,只是多了「已打开」一项,不算破坏性变更)。 */
const ResultBody = z.xor(ClientCallResult.options).openapi({}, { unionPreferredType: 'oneOf' });

const resultRoute = createRoute({
    method: 'post',
    path: '/tool-calls/{callId}/result',
    tags: ['tools'],
    summary:
        'Return the result of a call the server asked the desktop client to run (a screenshot, or opening a file or address)',
    request: {
        params: z.object({ callId: ClientCallId }),
        body: { content: { 'application/json': { schema: ResultBody } }, required: true },
    },
    responses: {
        204: { description: 'Accepted' },
        400: problem('Invalid result'),
        404: problem('No such pending call'),
        409: problem('The call already has a result, was cancelled or has expired'),
        ...authErrors,
    },
});

export function clientCallRoutes({ calls }: ClientCallRouteDeps) {
    return router().openapi(resultRoute, (c) => {
        const ownerId = requireOwner(c);
        const outcome = calls.complete(ownerId, c.req.valid('param').callId, c.req.valid('json'));
        if (outcome === 'not_found') throw notFound('Client call');
        if (outcome === 'conflict') {
            throw new ApiError(409, 'conflict', 'Conflict', 'The call already has a result, was cancelled or expired.');
        }
        return c.body(null, 204);
    });
}

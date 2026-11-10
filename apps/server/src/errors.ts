// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type ErrorCode, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@ai-personal/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { AppEnv } from './env.js';

/** 业务错误;由统一错误处理转换为 problem+json(ADR 0004 第 3 节)。 */
export class ApiError extends Error {
    constructor(
        readonly status: ContentfulStatusCode,
        readonly code: ErrorCode,
        readonly title: string,
        readonly detail?: string,
        readonly extra: Partial<Pick<ProblemDetails, 'issues' | 'providerCode'>> & {
            headers?: Record<string, string>;
        } = {},
    ) {
        super(detail ?? title);
    }
}

export const unauthorized = () => new ApiError(401, 'unauthorized', 'Unauthorized', 'Authentication is required.');
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', 'Not Found', `${what} was not found.`);

export function problemResponse(c: Context<AppEnv>, error: ApiError): Response {
    const body: ProblemDetails = {
        type: 'about:blank',
        title: error.title,
        status: error.status,
        code: error.code,
        requestId: c.get('requestId') ?? 'unknown',
        ...(error.detail ? { detail: error.detail } : {}),
        ...(error.extra.issues ? { issues: error.extra.issues } : {}),
        ...(error.extra.providerCode ? { providerCode: error.extra.providerCode } : {}),
    };
    return new Response(JSON.stringify(body), {
        status: error.status,
        headers: { 'content-type': PROBLEM_CONTENT_TYPE, ...error.extra.headers },
    });
}

export function validationError(error: ZodError): ApiError {
    return new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
        issues: error.issues.map((issue) => ({
            path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
            message: issue.message,
        })),
    });
}

/** 统一错误处理:不把内部错误信息或堆栈返回给客户端,只写本地日志。 */
export function handleError(err: Error, c: Context<AppEnv>): Response {
    if (err instanceof ApiError) return problemResponse(c, err);
    if (err instanceof ZodError) return problemResponse(c, validationError(err));
    if (err instanceof HTTPException) {
        const status = err.status as ContentfulStatusCode;
        const code: ErrorCode = status === 413 ? 'validation_failed' : status === 401 ? 'unauthorized' : 'internal';
        return problemResponse(c, new ApiError(status, code, err.message || 'Error'));
    }
    c.get('logger')?.error({ err, path: c.req.path }, 'unhandled error');
    return problemResponse(c, new ApiError(500, 'internal', 'Internal Server Error'));
}

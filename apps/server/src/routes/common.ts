// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { OpenAPIHono } from '@hono/zod-openapi';
import { ProblemDetails } from '@fatcat-ai/shared';
import type { AppEnv } from '../env.js';
import { validationError } from '../errors.js';

/** 所有路由组共用:参数校验失败时抛出 validation_failed,由统一错误处理返回 problem+json。 */
export function router(): OpenAPIHono<AppEnv> {
    return new OpenAPIHono<AppEnv>({
        defaultHook: (result) => {
            if (!result.success) throw validationError(result.error);
        },
    });
}

export const json = <T>(schema: T, description: string) => ({
    content: { 'application/json': { schema } },
    description,
});

/** 文档中通用的错误响应。 */
export const problem = (description: string) => ({
    content: { 'application/problem+json': { schema: ProblemDetails } },
    description,
});

export const authErrors = {
    401: problem('Authentication is required'),
    403: problem('CSRF token missing or invalid'),
};

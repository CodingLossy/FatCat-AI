// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 包里抛的 ServiceError 与服务器的 ApiError 走同一个错误处理(ADR 0050 第 1 节)。
import { notFoundError, PROBLEM_CONTENT_TYPE, ProblemDetails, ServiceError } from '@fatcat-ai/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from './env.js';
import { ApiError, handleError } from './errors.js';

function appThrowing(error: Error) {
    const app = new Hono<AppEnv>();
    app.onError(handleError);
    app.get('/x', () => {
        throw error;
    });
    return app;
}

describe('ServiceError', () => {
    it('becomes problem+json with its status, code, detail and headers', async () => {
        const res = await appThrowing(
            new ServiceError(502, 'provider_error', 'Bad Gateway', 'No QR code.', { headers: { 'Retry-After': '5' } }),
        ).request('/x');
        expect(res.status).toBe(502);
        expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
        expect(res.headers.get('retry-after')).toBe('5');
        expect(ProblemDetails.parse(await res.json())).toMatchObject({
            status: 502,
            code: 'provider_error',
            title: 'Bad Gateway',
            detail: 'No QR code.',
        });
    });

    it('notFoundError matches the server notFound; ApiError is a ServiceError', async () => {
        const res = await appThrowing(notFoundError('Plugin')).request('/x');
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'not_found', detail: 'Plugin was not found.' });
        expect(new ApiError(409, 'not_found', 'Conflict')).toBeInstanceOf(ServiceError);
    });
});

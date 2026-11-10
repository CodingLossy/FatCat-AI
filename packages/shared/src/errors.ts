// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';

/** 机器可读错误码。只增不改;客户端须把未知值当作通用错误(ADR 0004)。 */
export const ErrorCode = z.enum([
    'unauthorized',
    'forbidden',
    'csrf_failed',
    'not_found',
    'conflict',
    'validation_failed',
    'rate_limited',
    'not_initialized',
    'already_initialized',
    'model_profile_missing',
    'model_key_missing',
    'provider_error',
    'run_not_active',
    'approval_not_pending',
    'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** 上游模型错误的归类(ADR 0006)。 */
export const ProviderErrorCode = z.enum([
    'auth_failed',
    'not_found',
    'rate_limited',
    'timeout',
    'bad_request',
    'upstream_error',
    'network_error',
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCode>;

export const ValidationIssue = z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
});

/** RFC 9457 problem details,content-type 为 application/problem+json。 */
export const ProblemDetails = z.object({
    type: z.string().default('about:blank'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: ErrorCode,
    detail: z.string().optional(),
    requestId: z.string(),
    issues: z.array(ValidationIssue).optional(),
    providerCode: ProviderErrorCode.optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

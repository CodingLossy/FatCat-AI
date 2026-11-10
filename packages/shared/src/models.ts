// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

export const ModelKind = z.enum(['openai-compatible', 'anthropic', 'gemini']);
export type ModelKind = z.infer<typeof ModelKind>;

export const ModelPurpose = z.enum(['chat', 'cheap', 'embed', 'stt', 'tts']);
export type ModelPurpose = z.infer<typeof ModelPurpose>;

/**
 * 密钥引用:env:NAME 读环境变量,file:NAME 读数据目录 secrets.yaml 中的键,null 表示不需要密钥。
 * API 与 Web UI 不接收明文密钥(ADR 0006)。
 */
export const ApiKeyRef = z
    .string()
    .regex(/^(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be env:NAME or file:NAME')
    .nullable();
export type ApiKeyRef = z.infer<typeof ApiKeyRef>;

export const ModelParams = z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
});

/** 未知字段一律拒绝,避免客户端误把明文密钥放进其他字段后被静默丢弃(ADR 0006)。 */
const ModelProfileFields = z.strictObject({
    label: z.string().min(1).max(60),
    kind: ModelKind,
    baseURL: z.url({ protocol: /^https?$/ }).optional(),
    apiKeyRef: ApiKeyRef,
    model: z.string().min(1).max(200),
    purpose: z.array(ModelPurpose).min(1),
    contextWindow: z.number().int().min(1024).max(2_000_000).optional(),
    params: ModelParams.optional(),
});

const requireBaseUrl = (p: { kind?: ModelKind; baseURL?: string | undefined }) =>
    p.kind !== 'openai-compatible' || p.baseURL !== undefined;
const baseUrlIssue = { message: 'baseURL is required for openai-compatible profiles', path: ['baseURL'] };

export const ModelProfileInput = ModelProfileFields.refine(requireBaseUrl, baseUrlIssue);
export type ModelProfileInput = z.infer<typeof ModelProfileInput>;

/** PATCH:字段均可选;改 kind 为 openai-compatible 时仍须给出 baseURL(服务端合并后再校验)。 */
export const ModelProfilePatch = ModelProfileFields.partial();
export type ModelProfilePatch = z.infer<typeof ModelProfilePatch>;

export const KeyStatus = z.enum(['present', 'missing', 'not_required']);

export const ModelProfile = ModelProfileFields.extend({
    id: Id,
    keyStatus: KeyStatus,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const ModelTestResult = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), latencyMs: z.number().nonnegative(), models: z.array(z.string()).optional() }),
    z.object({
        ok: z.literal(false),
        error: z.enum([
            'auth_failed',
            'not_found',
            'rate_limited',
            'timeout',
            'bad_request',
            'upstream_error',
            'network_error',
            'key_missing',
        ]),
        message: z.string(),
    }),
]);
export type ModelTestResult = z.infer<typeof ModelTestResult>;

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
    /** 以下自 M4 起提供(ADR 0020 第 4 节)。 */
    'model_no_vision',
    'payload_too_large',
    'unsupported_media_type',
    /** 以下自 M7 起提供(ADR 0040)。 */
    'plugin_package_invalid',
    'plugin_manifest_invalid',
    'plugin_incompatible',
    'plugin_secrets_missing',
    'plugin_staging_not_found',
    /** 以下自 M7 PR 4 起提供(插件市场,ADR 0040 第 5.2、5.3 节)。 */
    'market_disabled',
    'market_unavailable',
    'plugin_download_failed',
    'plugin_too_large',
    'plugin_checksum_mismatch',
    'plugin_manifest_mismatch',
    'plugin_yanked',
    /** 以下自 M7 PR 5 起提供(升级与回退、本地插件的平台限制,ADR 0040 第 3.4、6.2 节)。 */
    'plugin_upgrade_failed',
    'plugin_backup_too_large',
    'plugin_network_unsupported',
    /** 以下自 2.0 起提供(多用户,ADR 0053 第 6 节):只有管理员能做的操作。 */
    'admin_required',
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
    /** 模型把工具调用写成了正文里无法解析的标记(例如 DeepSeek 的 DSML)。 */
    'malformed_tool_call',
    /** 模型没有给出任何可展示的回答。 */
    'empty_response',
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
    /** 稳定的原因码(例如任务相关的 `task_time_past`);客户端据此显示本地化文字,`detail` 仍是英文说明。 */
    reason: z.string().max(64).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** `ServiceError` 的附加字段:与 problem details 的可选字段对应,另可带响应头(例如 Retry-After)。 */
export type ServiceErrorExtra = Partial<Pick<ProblemDetails, 'issues' | 'providerCode' | 'reason'>> & {
    headers?: Record<string, string>;
};

/**
 * 带 HTTP 状态码与稳定错误码的业务错误(ADR 0050 第 1 节)。服务器的统一错误处理把它转成 problem+json;
 * 服务器以外的包(渠道中枢、插件服务)只用它,不依赖 HTTP 框架。
 */
export class ServiceError extends Error {
    constructor(
        readonly status: number,
        readonly code: ErrorCode,
        readonly title: string,
        readonly detail?: string,
        readonly extra: ServiceErrorExtra = {},
    ) {
        super(detail ?? title);
    }
}

export const notFoundError = (what = 'Resource') =>
    new ServiceError(404, 'not_found', 'Not Found', `${what} was not found.`);

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ProblemDetails } from '@ai-personal/shared';

/** 服务器返回非 2xx 时抛出;problem 为解析出的 RFC 9457 正文(解析失败时为合成的最小结构)。 */
export class AipApiError extends Error {
    readonly status: number;
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
        this.name = 'AipApiError';
        this.status = problem.status;
        this.problem = problem;
    }

    /** 机器可读错误码;未知值按通用错误处理(ADR 0004 第 3 节)。 */
    get code(): string {
        return this.problem.code;
    }
}

/** 网络层失败(连不上、连接中断、续看次数用尽)。 */
export class AipNetworkError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'AipNetworkError';
    }
}

export async function errorFromResponse(res: Response): Promise<AipApiError> {
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        body = undefined;
    }
    const b = (body ?? {}) as Partial<ProblemDetails>;
    const problem: ProblemDetails = {
        type: typeof b.type === 'string' ? b.type : 'about:blank',
        title: typeof b.title === 'string' ? b.title : res.statusText || `HTTP ${res.status}`,
        status: res.status,
        code: (typeof b.code === 'string' ? b.code : 'internal') as ProblemDetails['code'],
        requestId: typeof b.requestId === 'string' ? b.requestId : (res.headers.get('x-request-id') ?? ''),
        ...(typeof b.detail === 'string' ? { detail: b.detail } : {}),
        ...(Array.isArray(b.issues) ? { issues: b.issues } : {}),
        ...(typeof b.providerCode === 'string' ? { providerCode: b.providerCode } : {}),
    };
    return new AipApiError(problem);
}

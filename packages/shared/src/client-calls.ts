// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 客户端执行的工具调用(ADR 0046 第 3.6 节、第 14 节):核心没有渲染引擎,截图这类动作由已连接的桌面客户端完成。
// 核心通过 WebSocket 的 client-call 帧把请求推给声明了对应能力的连接,桌面客户端把结果 POST 回
// /api/v1/tool-calls/{callId}/result。只增不改;旧客户端不声明能力,不会收到这些帧。
import { z } from 'zod';
import { IsoDateTime } from './common.js';

/** 客户端可以声明的能力。 */
export const ClientCapabilities = z.object({
    /** 内置浏览器面板可用(桌面壳里)。 */
    browser: z.boolean(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilities>;

/** 一次客户端执行的调用的标识:服务器生成的不可猜测的随机串,和模型的工具调用 id 无关。 */
export const ClientCallId = z.string().regex(/^cc_[A-Za-z0-9_-]{16,64}$/);

/** 服务器 → 桌面客户端(client-call 帧的载荷)。 */
export const ClientCall = z.object({
    callId: ClientCallId,
    tool: z.literal('browser.screenshot'),
    /** 要渲染的页面;已通过核心的协议与主机检查,壳还会再检查一次。 */
    url: z.string().max(2048),
    expiresAt: IsoDateTime,
});
export type ClientCall = z.infer<typeof ClientCall>;

/** 截图解码后的字节上限(整个请求体受 2 MiB 的默认上限约束,base64 约增大三分之一)。 */
export const CLIENT_CALL_IMAGE_MAX_BYTES = 1_500_000;
/** 其他(非图像)结果的上限:64 KiB。 */
export const CLIENT_CALL_RESULT_MAX_BYTES = 64 * 1024;

export const ClientCallFailureCode = z.enum([
    'unsupported',
    'blocked',
    'timeout',
    'load_failed',
    'too_large',
    'failed',
]);
export type ClientCallFailureCode = z.infer<typeof ClientCallFailureCode>;

/** POST /tool-calls/{callId}/result 的请求体。 */
export const ClientCallResult = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        mimeType: z.enum(['image/png', 'image/jpeg']),
        width: z.number().int().min(1).max(16_384),
        height: z.number().int().min(1).max(16_384),
        /** base64,不含 data: 前缀。 */
        data: z
            .string()
            .min(1)
            .max(Math.ceil((CLIENT_CALL_IMAGE_MAX_BYTES * 4) / 3) + 8),
    }),
    z.object({ ok: z.literal(false), code: ClientCallFailureCode, message: z.string().max(300).optional() }),
]);
export type ClientCallResult = z.infer<typeof ClientCallResult>;

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { EventEnvelope } from './events.js';
import { ProblemDetails } from './errors.js';
import { PROTOCOL_VERSION } from './meta.js';

/** WebSocket 心跳间隔(毫秒)。 */
export const WS_PING_INTERVAL_MS = 30_000;

/** 帧结构 {v, type, id, seq?, payload}(计划 6.1、ADR 0004)。 */
const frame = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.object({
        v: z.literal(PROTOCOL_VERSION),
        type: z.literal(type),
        id: z.string().min(1).max(64),
        payload,
    });

/** 客户端 → 服务器。 */
export const ClientFrame = z.discriminatedUnion('type', [
    frame(
        'hello',
        z.object({
            protocolVersion: z.number().int().positive(),
            /** 已收到的最大 seq;服务器先补发其后的事件。 */
            lastSeq: z.number().int().nonnegative().optional(),
        }),
    ),
    frame('ping', z.object({})),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** 服务器 → 客户端。 */
export const ServerFrame = z.discriminatedUnion('type', [
    frame(
        'welcome',
        z.object({
            protocolVersion: z.number().int().positive(),
            serverVersion: z.string(),
            /** 补发是否完整;为 false 表示 lastSeq 已超出补发窗口,客户端应改读消息列表。 */
            replayComplete: z.boolean(),
        }),
    ),
    frame('event', EventEnvelope).extend({ seq: z.number().int().positive() }),
    frame('pong', z.object({})),
    frame('error', ProblemDetails),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

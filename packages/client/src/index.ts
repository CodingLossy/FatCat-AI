// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// AI-Personal API v1 的 TypeScript 客户端(ADR 0008):零运行时依赖,Node ≥ 22 与浏览器通用。
export { createClient, type AipClient, type ClientOptions, type Page, type PageParams } from './client.js';
export { AipApiError, AipNetworkError } from './errors.js';
export { RunStream, type StreamOptions } from './run-stream.js';
export { parseSse, type SseMessage } from './sse.js';
export {
    CLIENT_PROTOCOL_VERSION,
    type ConnectEventsOptions,
    type EventConnection,
    type WebSocketFactory,
    type WebSocketLike,
} from './ws.js';
export type * from '@ai-personal/shared';

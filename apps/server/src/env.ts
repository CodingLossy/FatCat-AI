// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Logger } from './log.js';

/** 已通过鉴权的请求主体。1.0 只有主人账户,来源是浏览器会话、个人访问令牌或已配对设备的令牌(ADR 0045)。 */
export type AuthContext =
    | { kind: 'session'; ownerId: string; sessionHash: string }
    | { kind: 'token'; ownerId: string; tokenId: string }
    | { kind: 'device'; ownerId: string; deviceId: string };

/** Hono 上下文变量。 */
export interface AppEnv {
    Variables: {
        requestId: string;
        logger: Logger;
        auth: AuthContext | null;
    };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

export const Username = z.string().regex(/^[a-zA-Z0-9_.-]{3,32}$/, '3-32 letters, digits, "_", "." or "-"');
/** 密码至少 12 位;上限防止过长输入拖慢哈希。 */
export const Password = z.string().min(12).max(256);

export const AuthStatus = z.object({
    initialized: z.boolean(),
    authenticated: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** 首次启动创建主人账户;非本机请求需携带启动日志中打印的一次性设置码。 */
export const SetupRequest = z.object({
    username: Username,
    password: Password,
    setupCode: z.string().min(6).max(64).optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({
    username: Username,
    password: Password,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** 登录响应;会话 Cookie 由 Set-Cookie 下发,csrfToken 用于修改类请求的 X-CSRF-Token 头。 */
export const LoginResponse = z.object({
    owner: z.object({ id: Id, username: Username }),
    csrfToken: z.string(),
    expiresAt: IsoDateTime,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const Me = z.object({ id: Id, username: Username, createdAt: IsoDateTime });
export type Me = z.infer<typeof Me>;

export const CreateTokenRequest = z.object({
    name: z.string().min(1).max(60),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

export const AccessToken = z.object({
    id: Id,
    name: z.string(),
    createdAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
    expiresAt: IsoDateTime.nullable(),
});
export type AccessToken = z.infer<typeof AccessToken>;

/** 创建令牌的响应;明文 token 只在此时返回一次。 */
export const CreatedAccessToken = AccessToken.extend({
    token: z.string().regex(/^aip_pat_[A-Za-z0-9_-]{32,}$/),
});
export type CreatedAccessToken = z.infer<typeof CreatedAccessToken>;

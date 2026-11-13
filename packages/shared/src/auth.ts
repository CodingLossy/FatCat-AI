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

// ---- TOTP 两步验证(ADR 0027,自 M5b 起提供;只新增,上面的 schema 不变) ----

/** 6 位数字验证码(RFC 6238)。 */
export const TotpCode = z.string().regex(/^\d{6}$/, '6 digits');
export type TotpCode = z.infer<typeof TotpCode>;

/** 一次性恢复码:两组各 5 位 Crockford Base32,服务器比较前统一转大写。 */
export const RecoveryCode = z
    .string()
    .trim()
    .regex(/^[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{5}-[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{5}$/, 'XXXXX-XXXXX');
export type RecoveryCode = z.infer<typeof RecoveryCode>;

const exactlyOneFactor = (v: { code?: string | undefined; recoveryCode?: string | undefined }) =>
    (v.code === undefined) !== (v.recoveryCode === undefined);
const ONE_FACTOR = { message: 'give exactly one of code or recoveryCode' };

/**
 * 已启用 TOTP 的账户在 POST /auth/login 密码通过后返回 202 与此体(不是会话);
 * 临时凭证有效 5 分钟,只能用于 POST /auth/login/totp,不能当会话或个人访问令牌用。
 */
export const LoginChallenge = z.object({
    totpRequired: z.literal(true),
    challengeToken: z.string().min(16).max(256),
    expiresAt: IsoDateTime,
});
export type LoginChallenge = z.infer<typeof LoginChallenge>;

/** POST /auth/login/totp;成功返回 LoginResponse。 */
export const TotpLoginRequest = z
    .object({
        challengeToken: LoginChallenge.shape.challengeToken,
        code: TotpCode.optional(),
        recoveryCode: RecoveryCode.optional(),
    })
    .refine(exactlyOneFactor, ONE_FACTOR);
export type TotpLoginRequest = z.infer<typeof TotpLoginRequest>;

/** GET /auth/totp。 */
export const TotpStatus = z.object({
    enabled: z.boolean(),
    enabledAt: IsoDateTime.nullable(),
    recoveryCodesRemaining: z.number().int().min(0).max(10),
});
export type TotpStatus = z.infer<typeof TotpStatus>;

/** POST /auth/totp/setup:要求当前密码;生成待确认的共享密钥,尚未生效。 */
export const TotpSetupRequest = z.object({ password: Password });
export type TotpSetupRequest = z.infer<typeof TotpSetupRequest>;

/** 共享密钥与二维码内容只在这一次响应里出现。 */
export const TotpSetup = z.object({
    /** otpauth://totp/… URI,用于生成二维码。 */
    otpauthUri: z.string().startsWith('otpauth://totp/'),
    /** Base32 共享密钥,供无法扫码时手动输入。 */
    secret: z.string().regex(/^[A-Z2-7]{32}$/),
});
export type TotpSetup = z.infer<typeof TotpSetup>;

/** POST /auth/totp/enable:当前密码加一次验证码。 */
export const TotpEnableRequest = z.object({ password: Password, code: TotpCode });
export type TotpEnableRequest = z.infer<typeof TotpEnableRequest>;

/** 恢复码明文只在启用或重新生成时返回一次。 */
export const TotpRecoveryCodes = z.object({ recoveryCodes: z.array(RecoveryCode).length(10) });
export type TotpRecoveryCodes = z.infer<typeof TotpRecoveryCodes>;

/** POST /auth/totp/disable 与 POST /auth/totp/recovery-codes(重新生成):当前密码加第二因素。 */
export const TotpConfirmRequest = z
    .object({ password: Password, code: TotpCode.optional(), recoveryCode: RecoveryCode.optional() })
    .refine(exactlyOneFactor, ONE_FACTOR);
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequest>;

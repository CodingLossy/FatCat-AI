// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设备配对与设备令牌(ADR 0045 第 1 节)。手机等设备用一次性配对码换令牌,不需要输入账户密码。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

/** 配对码:两组各 5 位 Crockford Base32(去掉易混字符),服务器比较前统一转大写、去掉连字符。 */
export const PairingCode = z
    .string()
    .trim()
    .regex(/^[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{5}-?[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{5}$/, 'XXXXX-XXXXX');
export type PairingCode = z.infer<typeof PairingCode>;

/** POST /devices/pairing-codes 的响应;明文配对码只在此时返回一次,5 分钟内一次有效。 */
export const CreatedPairingCode = z.object({
    code: PairingCode,
    expiresAt: IsoDateTime,
});
export type CreatedPairingCode = z.infer<typeof CreatedPairingCode>;

export const Device = z.object({
    id: Id,
    name: z.string().min(1).max(60),
    createdAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
});
export type Device = z.infer<typeof Device>;

/** POST /devices/pair:用配对码换设备令牌(公开端点,有限速)。 */
export const PairDeviceRequest = z.object({
    code: PairingCode,
    name: z.string().trim().min(1).max(60),
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>;

/** POST /devices/token:用 refresh 令牌换一组新令牌(refresh 每次使用都轮换)。 */
export const RefreshDeviceTokenRequest = z.object({
    refreshToken: z.string().regex(/^aip_ref_[A-Za-z0-9_-]{32,}$/),
});
export type RefreshDeviceTokenRequest = z.infer<typeof RefreshDeviceTokenRequest>;

/** 配对与刷新的响应;令牌明文只在此时返回一次。 */
export const DeviceTokens = z.object({
    device: Device,
    accessToken: z.string().regex(/^aip_dev_[A-Za-z0-9_-]{32,}$/),
    accessExpiresAt: IsoDateTime,
    refreshToken: z.string().regex(/^aip_ref_[A-Za-z0-9_-]{32,}$/),
    refreshExpiresAt: IsoDateTime,
});
export type DeviceTokens = z.infer<typeof DeviceTokens>;

export const RenameDeviceRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type RenameDeviceRequest = z.infer<typeof RenameDeviceRequest>;

export const DeviceEventKind = z.enum([
    'pairing-code-created',
    'paired',
    'pairing-failed',
    'refreshed',
    'replay-revoked',
    'renamed',
    'revoked',
    'self-revoked',
]);
export type DeviceEventKind = z.infer<typeof DeviceEventKind>;

/** 设备相关的审计事件(只追加);摘要里不含任何令牌或配对码。 */
export const DeviceEvent = z.object({
    id: Id,
    at: IsoDateTime,
    event: DeviceEventKind,
    deviceId: Id.nullable(),
    summary: z.string(),
});
export type DeviceEvent = z.infer<typeof DeviceEvent>;

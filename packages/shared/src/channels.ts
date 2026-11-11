// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// IM 渠道的公开契约(ADR 0022)。接口实现见 M5a PR 5(框架)与 PR 7(微信 iLink);
// 本文件只新增 schema,不改动已有 schema。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

/**
 * 渠道类型。1.0 先做微信(iLink);企业微信已推迟(业主 2026-11-11),以后作为新值加入。
 * 枚举只增不改:客户端必须把未知的 kind 当作「不认识的渠道」显示,不能报错(ADR 0004)。
 */
export const ChannelKind = z.enum(['wechat']);
export type ChannelKind = z.infer<typeof ChannelKind>;

/**
 * 渠道运行状态:stopped 已停用;starting 启动中;running 正常收发;
 * needs-login 需要(重新)扫码授权;backoff 出错后等待重启;error 连续失败后停止重试,需要人工处理。
 */
export const ChannelState = z.enum(['stopped', 'starting', 'running', 'needs-login', 'backoff', 'error']);
export type ChannelState = z.infer<typeof ChannelState>;

/** 绑定的主人账号。外部 id 只返回打码后的形式(保留末 4 位),完整值不出服务器。 */
export const ChannelBinding = z.object({
    maskedExternalUserId: z.string(),
    boundAt: IsoDateTime,
});
export type ChannelBinding = z.infer<typeof ChannelBinding>;

/** `GET /api/v1/channels` 列表项与 `GET /api/v1/channels/{id}`。不含任何密钥或密钥引用。 */
export const Channel = z.object({
    id: Id,
    kind: ChannelKind,
    label: z.string().min(1).max(40),
    enabled: z.boolean(),
    /** 这个渠道当前使用的会话;还没有收到过主人消息时为 null。 */
    sessionId: Id.nullable(),
    binding: ChannelBinding.nullable(),
    /** 连续出现召回降级时推送一次提醒(ADR 0017 第 5 节);默认关闭。 */
    notifyDegraded: z.boolean(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Channel = z.infer<typeof Channel>;

/** `POST /api/v1/channels`。新建的渠道默认停用,扫码授权并启用后才开始收消息。 */
export const ChannelCreate = z.object({
    kind: ChannelKind,
    label: z.string().trim().min(1).max(40),
});
export type ChannelCreate = z.infer<typeof ChannelCreate>;

/** `PATCH /api/v1/channels/{id}`;只接受这几个字段,至少给一个。 */
export const ChannelPatch = z
    .object({
        label: z.string().trim().min(1).max(40).optional(),
        enabled: z.boolean().optional(),
        notifyDegraded: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type ChannelPatch = z.infer<typeof ChannelPatch>;

/** `POST /api/v1/channels/{id}/pairing`:6 位配对码,10 分钟内一次有效。明文只在这个响应里出现一次。 */
export const ChannelPairing = z.object({
    code: z.string().regex(/^\d{6}$/),
    expiresAt: IsoDateTime,
});
export type ChannelPairing = z.infer<typeof ChannelPairing>;

/** 最近一次错误;message 是给人看的英文短句,不含令牌、消息正文或外部账号。 */
export const ChannelError = z.object({
    code: z.string(),
    message: z.string(),
    at: IsoDateTime,
});
export type ChannelError = z.infer<typeof ChannelError>;

/** `GET /api/v1/channels/{id}/status`。计数自服务器启动起算,不落库。 */
export const ChannelStatus = z.object({
    state: ChannelState,
    lastError: ChannelError.nullable(),
    /** 下一次重启的时间(state 为 backoff 时)。 */
    retryAt: IsoDateTime.nullable(),
    lastInboundAt: IsoDateTime.nullable(),
    /** 被忽略的消息:非主人、群聊、未绑定时收到的消息(ADR 0022 第 3 节)。 */
    ignoredCount: z.number().int().min(0),
    /** 因限流回复「太快了」而没有处理的主人消息。 */
    rateLimitedCount: z.number().int().min(0),
});
export type ChannelStatus = z.infer<typeof ChannelStatus>;

/** `POST /api/v1/channels/{id}/wechat/login`:开始扫码授权。qrContent 由客户端自己渲染成二维码。 */
export const WechatLoginStart = z.object({
    loginId: z.string().min(1).max(128),
    qrContent: z.string().min(1).max(2048),
    expiresAt: IsoDateTime,
});
export type WechatLoginStart = z.infer<typeof WechatLoginStart>;

/** `GET /api/v1/channels/{id}/wechat/login`:轮询扫码状态。confirmed 之后令牌已写入 secrets.yaml。 */
export const WechatLoginState = z.object({
    state: z.enum(['pending', 'scanned', 'confirmed', 'expired', 'failed']),
    /** failed 时的原因码,例如 secrets_write_failed;其他状态省略。 */
    code: z.string().optional(),
});
export type WechatLoginState = z.infer<typeof WechatLoginState>;

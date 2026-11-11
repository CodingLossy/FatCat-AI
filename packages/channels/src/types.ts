// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道适配器接口(ADR 0022 第 2 节)。适配器只负责「和平台说话」;
// 绑定、会话、审批、过滤、去重、限流与格式降级都在框架里。
import type { ChannelKind, ChannelState } from '@fatcat-ai/shared';

export interface ChannelCapabilities {
    /** 平台能显示的富文本;'none' 只发纯文本。 */
    markup: 'none' | 'markdown-subset';
    /** 单条消息的最大字节数(UTF-8)。 */
    maxTextBytes: number;
    /** 平台会不会给出语音的文字结果(M5a 不做本地语音解码)。 */
    voiceTranscript: boolean;
}

export interface ChannelAdapter {
    readonly kind: ChannelKind;
    readonly capabilities: ChannelCapabilities;
    start(ctx: ChannelContext): Promise<void>;
    stop(): Promise<void>;
    send(target: ChannelTarget, message: OutboundMessage): Promise<void>;
}

/** 只允许记渠道 id、消息类型、长度与状态码;不记令牌、正文与外部账号。 */
export type LogFields = Record<string, string | number | boolean | null>;

export interface ChannelLogger {
    info(fields: LogFields, msg: string): void;
    warn(fields: LogFields, msg: string): void;
}

export interface ChannelSecrets {
    /** 读取密钥引用(env: / file:);未设置时为 null。写入运行时令牌随 PR 7(ADR 0022 第 9 节)。 */
    resolve(ref: string): string | null;
}

/** 适配器向框架报告的错误;message 是不含令牌与正文的英文短句。 */
export interface ChannelErrorReport {
    code: string;
    message: string;
}

export interface ChannelContext {
    readonly channelId: string;
    /** 把一条入站消息交给框架;框架负责去重、过滤与排队,适配器不判断主人。 */
    receive(message: InboundMessage): Promise<void>;
    /** 状态变化(needs-login 等)与最近错误;抛错或报告 error 时框架按退避重启。 */
    report(state: ChannelState, error?: ChannelErrorReport): void;
    secrets: ChannelSecrets;
    log: ChannelLogger;
    /** stop() 时中止长轮询。 */
    signal: AbortSignal;
}

export interface QuotedContent {
    kind: 'forwarded' | 'quote' | 'link-card';
    text: string;
}

export interface InboundMessage {
    externalMessageId: string;
    externalUserId: string;
    chat: 'direct' | 'group';
    /** 发送者自己打的字。 */
    text: string;
    /** 转发 / 引用 / 链接卡片等别人写的内容;框架按不可信内容处理(ADR 0022 第 5 节)。 */
    quoted: QuotedContent[];
    /** ISO,UTC。 */
    receivedAt: string;
    /** 只有平台给出文字结果时才有。 */
    voice?: { transcript: string };
    /** 平台要求回复时带上的上下文;框架原样传回,不记日志。 */
    replyContext?: string;
}

export interface ChannelTarget {
    externalUserId: string;
    replyContext?: string;
}

export interface OutboundMessage {
    /** 已按 capabilities 降级并切段后的一段;框架保证不超过 maxTextBytes。 */
    text: string;
}

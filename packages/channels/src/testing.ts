// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 假渠道适配器:只用于测试与评测,不连任何真实服务(ADR 0022 第 1 节)。
// 通过子路径 @fatcat-ai/channels/testing 导入,服务器的生产代码不引用它。
import type { ChannelKind } from '@fatcat-ai/shared';
import type {
    ChannelAdapter,
    ChannelCapabilities,
    ChannelContext,
    ChannelTarget,
    InboundMessage,
    OutboundMessage,
} from './types.js';

export interface FakeSent {
    target: ChannelTarget;
    text: string;
}

export interface FakeAdapterOptions {
    kind?: ChannelKind;
    capabilities?: Partial<ChannelCapabilities>;
    /** start() 前 n 次抛错(退避重启测试)。 */
    failStarts?: number;
}

let counter = 0;

export class FakeChannelAdapter implements ChannelAdapter {
    readonly kind: ChannelKind;
    readonly capabilities: ChannelCapabilities;
    readonly sent: FakeSent[] = [];
    starts = 0;
    stops = 0;
    ctx: ChannelContext | null = null;
    private failStarts: number;

    constructor(options: FakeAdapterOptions = {}) {
        this.kind = options.kind ?? 'wechat';
        this.capabilities = { markup: 'none', maxTextBytes: 2048, voiceTranscript: true, ...options.capabilities };
        this.failStarts = options.failStarts ?? 0;
    }

    start(ctx: ChannelContext): Promise<void> {
        this.starts += 1;
        if (this.failStarts > 0) {
            this.failStarts -= 1;
            return Promise.reject(new Error('fake start failure'));
        }
        this.ctx = ctx;
        return Promise.resolve();
    }

    stop(): Promise<void> {
        this.stops += 1;
        this.ctx = null;
        return Promise.resolve();
    }

    send(target: ChannelTarget, message: OutboundMessage): Promise<void> {
        this.sent.push({ target, text: message.text });
        return Promise.resolve();
    }

    /** 模拟平台投递一条消息;返回框架处理完成的 Promise。 */
    deliver(message: Partial<InboundMessage> & Pick<InboundMessage, 'externalUserId'>): Promise<void> {
        if (!this.ctx) throw new Error('the fake channel is not running');
        return this.ctx.receive({
            externalMessageId: `fake-${++counter}`,
            chat: 'direct',
            text: '',
            quoted: [],
            receivedAt: new Date().toISOString(),
            ...message,
        });
    }

    /** 发给某个外部账号的全部文本。 */
    textsTo(externalUserId: string): string[] {
        return this.sent.filter((s) => s.target.externalUserId === externalUserId).map((s) => s.text);
    }
}

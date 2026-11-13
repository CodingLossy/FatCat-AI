// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 微信 iLink 适配器(ADR 0022、ADR 0024):长轮询收消息、发纯文本。
// 一次只取平台给的一批,逐条交给框架处理完再取下一批,不在内存里堆积消息。
// 出错时报告 backoff 由框架按指数退避重启;令牌失效(-14)或没有令牌时报告 needs-login,等待重新扫码。
import { IlinkClient, IlinkError, ILINK_SESSION_EXPIRED, type IlinkMessage, type IlinkMessageItem } from './ilink.js';
import type {
    ChannelAdapter,
    ChannelCapabilities,
    ChannelContext,
    ChannelTarget,
    InboundMessage,
    OutboundMessage,
    QuotedContent,
} from './types.js';

/** 长轮询的默认挂起时间(协议说明:约 35 秒);本地超时再多给 10 秒。 */
const DEFAULT_POLL_MS = 35_000;
const POLL_MARGIN_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;
export const MIN_POLL_GAP_MS = 1000;

/** 两次轮询之间的等待;signal 中止(停止渠道或关机)时立刻结束,不等满这段时间。 */
export function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

export interface WechatAdapterOptions {
    /** 令牌的密钥引用(file:ILINK_TOKEN_<channelId>);未设置时为 null。 */
    tokenRef: string | null;
    /** 扫码确认时平台给出的 API 地址;未设置时用默认地址。 */
    baseUrl?: string;
    /** 长轮询游标;由调用方保存,重启适配器后接着上次的位置收。 */
    cursor: { get(): string; set(value: string): void };
    fetch?: typeof fetch;
}

function itemText(item: IlinkMessageItem | undefined): string {
    if (!item) return '';
    if (item.type === 1) return item.text_item?.text ?? '';
    if (item.type === 3) return item.voice_item?.text ?? '';
    return '';
}

/** 把一条 iLink 消息转成框架的入站消息;机器人自己发的、没有 id 或发送者的返回 null。 */
export function toInbound(msg: IlinkMessage, now: () => Date = () => new Date()): InboundMessage | null {
    if (msg.message_type === 2) return null;
    const rawId = msg.message_id ?? msg.client_id ?? msg.seq;
    if (rawId === undefined || rawId === '' || !msg.from_user_id) return null;
    const texts: string[] = [];
    const quoted: QuotedContent[] = [];
    let transcript = '';
    for (const item of msg.item_list ?? []) {
        if (item.type === 1 && item.text_item?.text) texts.push(item.text_item.text);
        if (item.type === 3 && item.voice_item?.text) transcript += item.voice_item.text;
        if (item.ref_msg) {
            const text = itemText(item.ref_msg.message_item) || item.ref_msg.title || '';
            if (text) quoted.push({ kind: 'quote', text });
        }
    }
    const created = typeof msg.create_time_ms === 'number' ? new Date(msg.create_time_ms) : null;
    const inbound: InboundMessage = {
        externalMessageId: String(rawId),
        externalUserId: msg.from_user_id,
        chat: msg.group_id ? 'group' : 'direct',
        text: texts.join('\n'),
        quoted,
        receivedAt: (created && !Number.isNaN(created.getTime()) ? created : now()).toISOString(),
    };
    if (transcript) inbound.voice = { transcript };
    if (msg.context_token) inbound.replyContext = msg.context_token;
    return inbound;
}

export class WechatAdapter implements ChannelAdapter {
    readonly kind = 'wechat' as const;
    /** 单条长度上限公开文档没有写;先按 2048 字节切段(待业主决定的问题)。 */
    readonly capabilities: ChannelCapabilities = { markup: 'none', maxTextBytes: 2048, voiceTranscript: true };
    private client: IlinkClient | null = null;
    private readonly stopper = new AbortController();
    private loop: Promise<void> | null = null;

    constructor(private readonly options: WechatAdapterOptions) {}

    start(ctx: ChannelContext): Promise<void> {
        const token = this.options.tokenRef ? ctx.secrets.resolve(this.options.tokenRef) : null;
        if (!token) {
            // 还没扫码不算错误:只显示「需要扫码登录」
            ctx.report('needs-login');
            return Promise.resolve();
        }
        this.client = new IlinkClient({
            token,
            ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        const signal = AbortSignal.any([ctx.signal, this.stopper.signal]);
        this.loop = this.poll(ctx, this.client, signal);
        return Promise.resolve();
    }

    private async poll(ctx: ChannelContext, client: IlinkClient, signal: AbortSignal): Promise<void> {
        let waitMs = DEFAULT_POLL_MS;
        while (!signal.aborted) {
            const started = Date.now();
            let batch;
            const timeout = AbortSignal.timeout(waitMs + POLL_MARGIN_MS);
            try {
                batch = await client.getUpdates(this.options.cursor.get(), AbortSignal.any([signal, timeout]));
            } catch (error) {
                if (signal.aborted) return;
                if (timeout.aborted) continue; // 本地超时按空结果处理,继续轮询
                if (error instanceof IlinkError && error.ret === ILINK_SESSION_EXPIRED) {
                    ctx.report('needs-login', {
                        code: 'login_expired',
                        message: 'The WeChat login expired. Scan the QR code in Settings again.',
                    });
                    return;
                }
                const code = error instanceof IlinkError ? error.code : 'poll_failed';
                ctx.log.warn({ code }, 'wechat poll failed');
                ctx.report('backoff', {
                    code: `poll_${code}`,
                    message: error instanceof IlinkError ? error.message : 'Receiving WeChat messages failed.',
                });
                return;
            }
            if (batch.timeoutMs && batch.timeoutMs > 0) waitMs = Math.min(batch.timeoutMs, 120_000);
            for (const msg of batch.msgs) {
                if (signal.aborted) return;
                const inbound = toInbound(msg);
                if (!inbound) continue;
                ctx.log.info({ type: inbound.voice ? 'voice' : 'text', length: inbound.text.length }, 'wechat message');
                try {
                    await ctx.receive(inbound);
                } catch {
                    ctx.log.warn({ code: 'receive_failed' }, 'wechat message handling failed');
                }
            }
            // 一批处理完才前移游标:中途重启时平台会重投,框架按消息 id 去重
            this.options.cursor.set(batch.cursor);
            // 平台没有挂起就立刻返回时,两次请求之间至少隔 1 秒,不空转
            await abortablePause(MIN_POLL_GAP_MS - (Date.now() - started), signal);
        }
    }

    async stop(): Promise<void> {
        this.stopper.abort();
        await this.loop?.catch(() => undefined);
        this.loop = null;
    }

    async send(target: ChannelTarget, message: OutboundMessage): Promise<void> {
        if (!this.client) throw new IlinkError('not_logged_in', 'The WeChat channel is not logged in.');
        const signal = AbortSignal.any([this.stopper.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]);
        await this.client.sendText(target.externalUserId, message.text, target.replyContext, signal);
    }
}

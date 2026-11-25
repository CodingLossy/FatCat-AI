// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// QQ 官方机器人适配器(ADR 0052):只用 WebSocket 网关收事件,只处理单聊;回复优先用被动消息。
// 资料只来自 QQ 开放平台的官方文档(bot.q.qq.com/wiki,接口 v2),见 ADR 0052 第 0 节。
// 出错时报告 backoff 由框架按指数退避重启;凭据不对、权限不够或机器人被下架时报告 needs-login,不再重试。
import { abortablePause } from './wechat.js';
import type {
    ChannelAdapter,
    ChannelCapabilities,
    ChannelContext,
    ChannelErrorReport,
    ChannelTarget,
    InboundMessage,
    OutboundMessage,
    QuotedContent,
} from './types.js';

/** 2026-08-10 起所有接口统一为这个域名(官方更新日志)。 */
export const QQ_API_BASE_URL = 'https://api.bot.qq.com';
export const QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const MAX_HEARTBEAT_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 45_000;

/** 单聊与群 @ 消息(`GROUP_AND_C2C_EVENT`);不请求频道事件。 */
export const QQ_INTENTS = 1 << 25;
/** 单聊被动回复:收到消息后 60 分钟内、每条最多 4 次(消息收发概述)。 */
export const PASSIVE_REPLY_WINDOW_MS = 60 * 60 * 1000;
export const PASSIVE_REPLIES_PER_MESSAGE = 4;
/** 到期前这么久就换新令牌;平台保证旧令牌在最后 60 秒仍可用。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_GAP_MS = 1000;
/** 连续这么多次连上却没走到 READY / RESUMED,交给框架退避。 */
const MAX_FAILED_CONNECTS = 5;
/** 记住多少条入站消息的 msg_seq(超出按时间丢最旧的)。 */
const MAX_REPLY_CONTEXTS = 500;

/** 平台的业务错误码:凭据不对(appid 无效、appid 或 secret 不对)。 */
const INVALID_CREDENTIAL_CODES = new Set([100007, 100016]);
/** 被动回复已过期、次数用完或 msg_id 无效:改发一次主动消息。 */
const PASSIVE_EXPIRED_CODES = new Set([304103, 40034005, 40034024, 40034128]);

export class QqError extends Error {
    override readonly name = 'QqError';
    constructor(
        readonly code: string,
        message: string,
        /** 平台返回的数字错误码(没有时为 null)。 */
        readonly platformCode: number | null = null,
    ) {
        super(message);
    }
}

/** 网关地址只接受 wss://,主机名是 qq.com 或以 .qq.com 结尾(按点边界),不带用户名密码。 */
export function isAllowedQqGatewayUrl(text: string): boolean {
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return url.protocol === 'wss:' && !url.username && !url.password && (host === 'qq.com' || host.endsWith('.qq.com'));
}

interface QqAuthor {
    user_openid?: string;
    member_openid?: string;
}

interface QqAttachment {
    content_type?: string;
    asr_refer_text?: string;
}

interface QqElement {
    content?: string;
    msg_elements?: QqElement[];
}

/** `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` 的 `d`(只列用到的字段)。 */
export interface QqMessageEvent {
    id?: string;
    author?: QqAuthor;
    content?: string;
    timestamp?: string;
    group_openid?: string;
    /** 0 文本;3 卡片;101 并行消息;102 聊天记录;103 引用。 */
    message_type?: number;
    attachments?: QqAttachment[];
    ark_data?: { prompt?: string };
    msg_elements?: QqElement[];
}

function elementText(elements: readonly QqElement[] | undefined, depth = 0): string {
    if (!elements || depth > 3) return '';
    return elements
        .map((e) => [e.content?.trim() ?? '', elementText(e.msg_elements, depth + 1)].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n');
}

/** 把一条消息事件转成框架的入站消息;没有 id 或发送者时返回 null。 */
export function qqToInbound(
    type: string,
    d: QqMessageEvent,
    now: () => Date = () => new Date(),
): InboundMessage | null {
    const group = type === 'GROUP_AT_MESSAGE_CREATE';
    const sender = group ? d.author?.member_openid : d.author?.user_openid;
    if (!d.id || !sender) return null;
    const quoted: QuotedContent[] = [];
    const referenced = elementText(d.msg_elements);
    if (referenced) quoted.push({ kind: d.message_type === 102 ? 'forwarded' : 'quote', text: referenced });
    if (d.message_type === 3 && d.ark_data?.prompt?.trim()) {
        quoted.push({ kind: 'link-card', text: d.ark_data.prompt.trim() });
    }
    const transcript = (d.attachments ?? [])
        .filter((a) => a.content_type === 'voice' && a.asr_refer_text?.trim())
        .map((a) => a.asr_refer_text!.trim())
        .join('\n');
    const created = d.timestamp ? new Date(d.timestamp) : null;
    const inbound: InboundMessage = {
        externalMessageId: d.id,
        externalUserId: sender,
        chat: group ? 'group' : 'direct',
        text: (d.content ?? '').trim(),
        quoted,
        receivedAt: (created && !Number.isNaN(created.getTime()) ? created : now()).toISOString(),
        replyContext: d.id,
    };
    if (transcript) inbound.voice = { transcript };
    return inbound;
}

export interface QqAdapterOptions {
    /** 渠道配置里的 AppID;未设置时为 null。 */
    appId: string | null;
    /** AppSecret 的密钥引用(file:QQBOT_SECRET_<channelId>);未设置时为 null。 */
    secretRef: string | null;
    /** 测试时指向本机假服务器;生产固定为官方地址。 */
    apiBaseUrl?: string;
    tokenUrl?: string;
    allowGatewayUrl?: (url: string) => boolean;
    fetch?: typeof fetch;
    WebSocket?: typeof WebSocket;
    now?: () => number;
    /** 心跳间隔的下限(毫秒);默认 1 秒,测试里调小。 */
    minHeartbeatMs?: number;
}

interface Frame {
    op: number;
    d?: unknown;
    s?: number | null;
    t?: string | null;
}

type SessionEnd =
    | { kind: 'reconnect'; resume: boolean; ready: boolean }
    | { kind: 'fatal'; state: 'needs-login' | 'backoff'; error: ChannelErrorReport };

/** 关闭码(官方 WebSocket 文档):哪些可以 Resume、哪些要重新 Identify、哪些不再重连。 */
function closeAction(code: number): 'resume' | 'identify' | 'fatal-login' | 'fatal-backoff' {
    if (code === 4008 || code === 4009) return 'resume';
    if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) return 'identify';
    if (code === 4013 || code === 4014 || code === 4914 || code === 4915) return 'fatal-login';
    if (code >= 4001 && code <= 4012) return 'fatal-backoff';
    // 1000 / 1006 等普通断线:能续就续
    return 'resume';
}

const CLOSE_MESSAGES: Record<number, ChannelErrorReport> = {
    4013: { code: 'qq_intent_not_permitted', message: 'The QQ bot is not allowed to receive direct messages.' },
    4014: { code: 'qq_intent_not_permitted', message: 'The QQ bot is not allowed to receive direct messages.' },
    4914: { code: 'qq_bot_unavailable', message: 'The QQ bot is delisted; only its sandbox can connect.' },
    4915: { code: 'qq_bot_unavailable', message: 'The QQ bot is banned.' },
};

/** 网关给的心跳间隔只在 [下限, 2 分钟] 内采用,其他值(非数字、过小、过大)用 45 秒,避免心跳风暴或长时间不检测断线。 */
export function heartbeatDelay(interval: number, min: number): number {
    if (Number.isFinite(interval) && interval >= min && interval <= MAX_HEARTBEAT_MS) return interval;
    return DEFAULT_HEARTBEAT_MS;
}

export class QqAdapter implements ChannelAdapter {
    readonly kind = 'qq' as const;
    /** 文档没写单条上限;先按 2048 字节切段,和微信一致(ADR 0052 第 3.4 节)。 */
    readonly capabilities: ChannelCapabilities = { markup: 'none', maxTextBytes: 2048, voiceTranscript: true };
    private readonly stopper = new AbortController();
    private loop: Promise<void> | null = null;
    private ctx: ChannelContext | null = null;
    private secret: string | null = null;
    private token: { value: string; expiresAt: number } | null = null;
    private tokenRequest: Promise<string> | null = null;
    private sessionId: string | null = null;
    private seq: number | null = null;
    private socket: WebSocket | null = null;
    /** 入站消息 id → 收到时间与已用的 msg_seq。 */
    private readonly replies = new Map<string, { at: number; seq: number }>();
    private readonly fetchImpl: typeof fetch;
    private readonly WebSocketImpl: typeof WebSocket;
    private readonly now: () => number;
    private readonly apiBaseUrl: string;

    constructor(private readonly options: QqAdapterOptions) {
        this.fetchImpl = options.fetch ?? fetch;
        this.WebSocketImpl = options.WebSocket ?? WebSocket;
        this.now = options.now ?? Date.now;
        this.apiBaseUrl = options.apiBaseUrl ?? QQ_API_BASE_URL;
    }

    start(ctx: ChannelContext): Promise<void> {
        this.ctx = ctx;
        this.secret = this.options.secretRef ? ctx.secrets.resolve(this.options.secretRef) : null;
        if (!this.options.appId || !this.secret) {
            // 还没填凭据不算错误:只显示「需要填写凭据」
            ctx.report('needs-login');
            return Promise.resolve();
        }
        const signal = AbortSignal.any([ctx.signal, this.stopper.signal]);
        this.loop = this.run(ctx, signal);
        return Promise.resolve();
    }

    async stop(): Promise<void> {
        this.stopper.abort();
        this.socket?.close(1000);
        await this.loop?.catch(() => undefined);
        this.loop = null;
    }

    /** 回复:入站消息 60 分钟内、每条 4 次以内带 msg_id 与递增的 msg_seq;否则(或平台说已过期)发主动消息。 */
    async send(target: ChannelTarget, message: OutboundMessage): Promise<void> {
        const passive = this.nextPassive(target.replyContext);
        const body: Record<string, unknown> = { content: message.text, msg_type: 0 };
        if (passive) Object.assign(body, { msg_id: passive.msgId, msg_seq: passive.seq });
        try {
            await this.post(`/v2/users/${encodeURIComponent(target.externalUserId)}/messages`, body);
        } catch (error) {
            if (!passive || !(error instanceof QqError) || !PASSIVE_EXPIRED_CODES.has(error.platformCode ?? -1)) {
                throw error;
            }
            this.replies.delete(passive.msgId);
            await this.post(`/v2/users/${encodeURIComponent(target.externalUserId)}/messages`, {
                content: message.text,
                msg_type: 0,
            });
        }
    }

    private nextPassive(msgId: string | undefined): { msgId: string; seq: number } | null {
        if (!msgId) return null;
        const entry = this.replies.get(msgId);
        if (!entry || this.now() - entry.at >= PASSIVE_REPLY_WINDOW_MS || entry.seq >= PASSIVE_REPLIES_PER_MESSAGE) {
            return null;
        }
        entry.seq += 1;
        return { msgId, seq: entry.seq };
    }

    private remember(msgId: string): void {
        this.replies.set(msgId, { at: this.now(), seq: 0 });
        while (this.replies.size > MAX_REPLY_CONTEXTS) this.replies.delete(this.replies.keys().next().value!);
    }

    private async post(path: string, body: unknown): Promise<unknown> {
        const token = await this.accessToken();
        const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
            method: 'POST',
            headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const data = (await response.json().catch(() => null)) as { code?: unknown } | null;
        if (!response.ok) {
            const code = typeof data?.code === 'number' ? data.code : null;
            throw new QqError(
                code === null ? `http_${response.status}` : `qq_${code}`,
                `The QQ API answered ${response.status}${code === null ? '' : ` (code ${code})`}.`,
                code,
            );
        }
        return data;
    }

    /** 访问令牌只在内存里;到期前 60 秒内换新的,同时只发一个请求。 */
    private accessToken(): Promise<string> {
        if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
            return Promise.resolve(this.token.value);
        }
        this.tokenRequest ??= this.fetchToken().finally(() => {
            this.tokenRequest = null;
        });
        return this.tokenRequest;
    }

    private async fetchToken(): Promise<string> {
        if (!this.options.appId || !this.secret) throw new QqError('not_configured', 'The QQ bot has no credentials.');
        const response = await this.fetchImpl(this.options.tokenUrl ?? QQ_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: this.options.appId, clientSecret: this.secret }),
            signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const data = (await response.json().catch(() => null)) as {
            access_token?: unknown;
            expires_in?: unknown;
            code?: unknown;
        } | null;
        // 业务错误也是 HTTP 200,要看 code
        const code = typeof data?.code === 'number' ? data.code : null;
        if (code !== null && INVALID_CREDENTIAL_CODES.has(code)) {
            throw new QqError('qq_credentials_invalid', 'The QQ AppID or AppSecret was rejected.', code);
        }
        const value = typeof data?.access_token === 'string' ? data.access_token : '';
        const seconds = Number(data?.expires_in);
        if (!response.ok || !value || !Number.isFinite(seconds) || seconds <= 0) {
            throw new QqError(
                code === null ? `token_http_${response.status}` : `token_${code}`,
                'Getting a QQ access token failed.',
                code,
            );
        }
        this.ctx?.secrets.protect(value);
        this.token = { value, expiresAt: this.now() + seconds * 1000 };
        return value;
    }

    private async gatewayUrl(): Promise<string> {
        const token = await this.accessToken();
        const response = await this.fetchImpl(`${this.apiBaseUrl}/gateway/bot`, {
            headers: { Authorization: `QQBot ${token}` },
            signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const data = (await response.json().catch(() => null)) as { url?: unknown } | null;
        if (!response.ok || typeof data?.url !== 'string') {
            throw new QqError(`gateway_http_${response.status}`, 'Getting the QQ gateway address failed.');
        }
        const allow = this.options.allowGatewayUrl ?? isAllowedQqGatewayUrl;
        if (!allow(data.url))
            throw new QqError('unexpected_host', 'The QQ gateway address is not a wss://*.qq.com URL.');
        return data.url;
    }

    private async run(ctx: ChannelContext, signal: AbortSignal): Promise<void> {
        let failed = 0;
        while (!signal.aborted) {
            let end: SessionEnd;
            try {
                const url = await this.gatewayUrl();
                end = await this.session(ctx, url, signal);
            } catch (error) {
                if (signal.aborted) return;
                const qq = error instanceof QqError ? error : null;
                if (qq?.code === 'qq_credentials_invalid') {
                    ctx.report('needs-login', {
                        code: qq.code,
                        message: 'The QQ AppID or AppSecret was rejected. Check them and save again.',
                    });
                    return;
                }
                ctx.log.warn({ code: qq?.code ?? 'connect_failed' }, 'qq gateway failed');
                ctx.report('backoff', {
                    code: qq?.code ?? 'connect_failed',
                    message: qq?.message ?? 'Connecting to QQ failed.',
                });
                return;
            }
            if (signal.aborted) return;
            if (end.kind === 'fatal') {
                ctx.log.warn({ code: end.error.code }, 'qq gateway closed');
                ctx.report(end.state, end.error);
                return;
            }
            if (!end.resume) {
                this.sessionId = null;
                this.seq = null;
            }
            failed = end.ready ? 0 : failed + 1;
            if (failed >= MAX_FAILED_CONNECTS) {
                ctx.report('backoff', {
                    code: 'reconnect_failed',
                    message: 'The QQ gateway keeps closing the connection.',
                });
                return;
            }
            await abortablePause(RECONNECT_GAP_MS, signal);
        }
    }

    /** 一次连接:Hello → Identify / Resume → 收事件;断开时说明下一步怎么做。 */
    private session(ctx: ChannelContext, url: string, signal: AbortSignal): Promise<SessionEnd> {
        return new Promise((resolve) => {
            const socket = new this.WebSocketImpl(url);
            this.socket = socket;
            let ready = false;
            let resume = this.sessionId !== null;
            let heartbeat: NodeJS.Timeout | null = null;
            let missed = 0;
            let chain: Promise<void> = Promise.resolve();
            let settled = false;
            const finish = (end: SessionEnd) => {
                if (settled) return;
                settled = true;
                if (heartbeat) clearInterval(heartbeat);
                signal.removeEventListener('abort', onAbort);
                if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1000);
                // 已经交给框架的消息处理完再返回,避免和下一次连接交错
                void chain.finally(() => resolve(end));
            };
            const onAbort = () => finish({ kind: 'reconnect', resume: true, ready });
            signal.addEventListener('abort', onAbort, { once: true });
            const sendFrame = (frame: Frame) => {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
            };

            socket.addEventListener('message', (event: MessageEvent) => {
                let frame: Frame;
                try {
                    frame = JSON.parse(String(event.data)) as Frame;
                } catch {
                    return;
                }
                if (typeof frame.s === 'number') this.seq = frame.s;
                switch (frame.op) {
                    case 10: {
                        const interval = Number(
                            (frame.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval,
                        );
                        heartbeat = setInterval(
                            () => {
                                // 连续两次没收到回执:当作断线
                                if (missed >= 2) return finish({ kind: 'reconnect', resume: true, ready });
                                missed += 1;
                                sendFrame({ op: 1, d: this.seq });
                            },
                            heartbeatDelay(interval, this.options.minHeartbeatMs ?? 1_000),
                        );
                        heartbeat.unref?.();
                        void this.accessToken().then(
                            (token) => {
                                if (resume && this.sessionId) {
                                    sendFrame({
                                        op: 6,
                                        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq },
                                    });
                                } else {
                                    resume = false;
                                    sendFrame({
                                        op: 2,
                                        d: {
                                            token: `QQBot ${token}`,
                                            intents: QQ_INTENTS,
                                            shard: [0, 1],
                                            properties: {
                                                $os: process.platform,
                                                $browser: 'fatcat-ai',
                                                $device: 'fatcat-ai',
                                            },
                                        },
                                    });
                                }
                            },
                            () => finish({ kind: 'reconnect', resume: false, ready }),
                        );
                        return;
                    }
                    case 11:
                        missed = 0;
                        return;
                    case 7:
                        return finish({ kind: 'reconnect', resume: true, ready });
                    case 9:
                        // 会话失效:丢掉 session_id 重新 Identify
                        return finish({ kind: 'reconnect', resume: false, ready });
                    case 0:
                        break;
                    default:
                        return;
                }
                if (frame.t === 'READY') {
                    const sessionId = (frame.d as { session_id?: unknown } | null)?.session_id;
                    if (typeof sessionId === 'string') this.sessionId = sessionId;
                    ready = true;
                    ctx.report('running');
                    return;
                }
                if (frame.t === 'RESUMED') {
                    ready = true;
                    ctx.report('running');
                    return;
                }
                if (frame.t !== 'C2C_MESSAGE_CREATE' && frame.t !== 'GROUP_AT_MESSAGE_CREATE') {
                    // 加好友、主动消息开关、群里加删机器人等:不进模型
                    if (frame.t) ctx.log.info({ event: frame.t }, 'qq event ignored');
                    return;
                }
                const inbound = qqToInbound(frame.t, (frame.d ?? {}) as QqMessageEvent);
                if (!inbound) return;
                if (inbound.chat === 'direct') this.remember(inbound.externalMessageId);
                // 一条一条交给框架,处理完再交下一条
                chain = chain.then(async () => {
                    if (signal.aborted) return;
                    ctx.log.info({ type: inbound.voice ? 'voice' : 'text', length: inbound.text.length }, 'qq message');
                    try {
                        await ctx.receive(inbound);
                    } catch {
                        ctx.log.warn({ code: 'receive_failed' }, 'qq message handling failed');
                    }
                });
            });

            socket.addEventListener('close', (event: CloseEvent) => {
                const action = closeAction(event.code);
                if (action === 'fatal-login' || action === 'fatal-backoff') {
                    const error = CLOSE_MESSAGES[event.code] ?? {
                        code: `qq_close_${event.code}`,
                        message: `The QQ gateway closed the connection (${event.code}).`,
                    };
                    return finish({
                        kind: 'fatal',
                        state: action === 'fatal-login' ? 'needs-login' : 'backoff',
                        error,
                    });
                }
                finish({ kind: 'reconnect', resume: action === 'resume', ready });
            });
            socket.addEventListener('error', () => {
                // close 事件随后到来;这里只防止没有 close 的情况
                if (socket.readyState === socket.CLOSED) finish({ kind: 'reconnect', resume: true, ready });
            });
        });
    }
}

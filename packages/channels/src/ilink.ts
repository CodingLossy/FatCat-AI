// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 微信 iLink 的 HTTP JSON 客户端(ADR 0022 第 13 节,ADR 0024)。
// 只依据公开的协议说明(Tencent/openclaw-weixin 的 docs/protocol.md)实现,不参考任何第三方源代码。
// 只做 1.0 需要的接口:扫码授权(get_bot_qrcode / get_qrcode_status)、长轮询收消息(getupdates)、发文本(sendmessage)。
import { randomBytes, randomUUID } from 'node:crypto';

/** 协议说明里的默认 API 地址;扫码一律从这里开始。 */
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * base_info.channel_version:服务器按前三个数字识别插件版本,宿主自己的版本写在后缀里(协议说明「Plugin version」)。
 * 我们不是 openclaw-weixin 插件,前三个数字取公开文档写这份说明时的插件版本;是否合适列为待业主决定的问题。
 */
export const ILINK_CHANNEL_VERSION = '2.4.10/fatcat-ai';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10); // 0x00MMNNPP 的十进制
const BOT_AGENT = 'FatCat-AI/0.1';
const APP_ID = 'bot';

/** 平台返回的业务错误码 -14:会话失效,需要重新扫码(协议说明「Return values and errors」)。 */
export const ILINK_SESSION_EXPIRED = -14;

export class IlinkError extends Error {
    override readonly name = 'IlinkError';
    constructor(
        /** http_<status>、ret_<n>、network、bad_response 之一;不含令牌与正文。 */
        readonly code: string,
        message: string,
        readonly ret?: number,
    ) {
        super(message);
    }
}

export interface IlinkClientOptions {
    baseUrl?: string;
    /** 没有令牌时只能调扫码接口。 */
    token?: string | null;
    fetch?: typeof fetch;
}

export interface IlinkMessageItem {
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
    ref_msg?: { title?: string; message_item?: IlinkMessageItem };
}

export interface IlinkMessage {
    seq?: number;
    message_id?: number | string;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    group_id?: string;
    message_type?: number;
    message_state?: number;
    item_list?: IlinkMessageItem[];
    context_token?: string;
}

export interface IlinkUpdates {
    msgs: IlinkMessage[];
    cursor: string;
    timeoutMs: number | null;
}

export interface IlinkQrCode {
    qrcode: string;
    qrContent: string;
}

export interface IlinkQrStatus {
    status: string;
    botToken?: string;
    baseUrl?: string;
    redirectHost?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** X-WECHAT-UIN:随机 uint32 的十进制字符串再做 base64。 */
function wechatUin(): string {
    return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
}

export class IlinkClient {
    readonly baseUrl: string;
    private readonly token: string | null;
    private readonly fetchImpl: typeof fetch;

    constructor(options: IlinkClientOptions = {}) {
        this.baseUrl = (options.baseUrl ?? ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.token = options.token ?? null;
        this.fetchImpl = options.fetch ?? fetch;
    }

    private headers(json: boolean, auth: boolean): Record<string, string> {
        const h: Record<string, string> = { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION };
        if (json) {
            h['Content-Type'] = 'application/json';
            h.AuthorizationType = 'ilink_bot_token';
            h['X-WECHAT-UIN'] = wechatUin();
        }
        if (auth && this.token) h.Authorization = `Bearer ${this.token}`;
        return h;
    }

    private async request(
        method: 'GET' | 'POST',
        path: string,
        body: Record<string, unknown> | null,
        signal: AbortSignal,
        auth = true,
    ): Promise<Record<string, unknown>> {
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                headers: this.headers(body !== null, auth),
                ...(body !== null ? { body: JSON.stringify(body) } : {}),
                signal,
            });
        } catch (error) {
            if (signal.aborted) throw error;
            throw new IlinkError('network', 'The WeChat service could not be reached.');
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw new IlinkError(`http_${res.status}`, `The WeChat service answered HTTP ${res.status}.`);
        }
        let data: unknown;
        try {
            data = await res.json();
        } catch {
            throw new IlinkError('bad_response', 'The WeChat service sent an unreadable response.');
        }
        if (!isObject(data)) throw new IlinkError('bad_response', 'The WeChat service sent an unreadable response.');
        return data;
    }

    private static baseInfo() {
        return { base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: BOT_AGENT } };
    }

    /** 业务返回码:ret 或 errcode 非零即失败。 */
    private static check(data: Record<string, unknown>): void {
        for (const key of ['ret', 'errcode'] as const) {
            const v = data[key];
            if (typeof v === 'number' && v !== 0) {
                throw new IlinkError(`ret_${v}`, `The WeChat service returned code ${v}.`, v);
            }
        }
    }

    /** 自己绑定:只带空的 local_token_list(1.0 不做实名代绑与 PIN)。 */
    async getQrCode(signal: AbortSignal): Promise<IlinkQrCode> {
        const data = await this.request(
            'POST',
            '/ilink/bot/get_bot_qrcode?bot_type=3',
            { local_token_list: [] },
            signal,
            false,
        );
        const { qrcode, qrcode_img_content: qrContent } = data;
        if (typeof qrcode !== 'string' || !qrcode || typeof qrContent !== 'string' || !qrContent) {
            throw new IlinkError('bad_response', 'The WeChat service did not return a QR code.');
        }
        return { qrcode, qrContent };
    }

    /** 扫码状态长轮询(平台最多挂起约 35 秒)。 */
    async getQrStatus(qrcode: string, signal: AbortSignal): Promise<IlinkQrStatus> {
        const data = await this.request(
            'GET',
            `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
            null,
            signal,
            false,
        );
        const str = (k: string) => (typeof data[k] === 'string' && data[k] ? (data[k] as string) : undefined);
        const status = str('status') ?? 'wait';
        const out: IlinkQrStatus = { status };
        const botToken = str('bot_token');
        const baseUrl = str('baseurl');
        const redirectHost = str('redirect_host');
        if (botToken) out.botToken = botToken;
        if (baseUrl) out.baseUrl = baseUrl;
        if (redirectHost) out.redirectHost = redirectHost;
        return out;
    }

    /** 长轮询收消息;cursor 是上一次返回的 get_updates_buf(第一次为空串)。 */
    async getUpdates(cursor: string, signal: AbortSignal): Promise<IlinkUpdates> {
        const data = await this.request(
            'POST',
            '/ilink/bot/getupdates',
            { get_updates_buf: cursor, ...IlinkClient.baseInfo() },
            signal,
        );
        IlinkClient.check(data);
        const msgs = Array.isArray(data.msgs) ? (data.msgs.filter(isObject) as IlinkMessage[]) : [];
        const next = typeof data.get_updates_buf === 'string' && data.get_updates_buf ? data.get_updates_buf : cursor;
        const timeoutMs = typeof data.longpolling_timeout_ms === 'number' ? data.longpolling_timeout_ms : null;
        return { msgs, cursor: next, timeoutMs };
    }

    async sendText(
        toUserId: string,
        text: string,
        contextToken: string | undefined,
        signal: AbortSignal,
    ): Promise<void> {
        const msg: Record<string, unknown> = {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
        };
        if (contextToken) msg.context_token = contextToken;
        const data = await this.request('POST', '/ilink/bot/sendmessage', { msg, ...IlinkClient.baseInfo() }, signal);
        IlinkClient.check(data);
    }
}

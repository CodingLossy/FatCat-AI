// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 微信 iLink 的服务器部分(ADR 0024):适配器工厂(保存长轮询游标)与扫码授权。
// 扫码确认后令牌按 ADR 0022 第 9 节写进 secrets.yaml 的 ILINK_TOKEN_<channelId>,渠道配置只记 file: 引用。
import { IlinkClient, IlinkError, WechatAdapter } from '@fatcat-ai/channels';
import type { SecretStore } from '@fatcat-ai/providers';
import type { WechatLoginStart, WechatLoginState } from '@fatcat-ai/shared';
import type { ChannelRecord, Repositories } from '@fatcat-ai/storage';
import { ApiError } from '../errors.js';
import type { Logger } from '../log.js';
import type { AdapterFactory, ChannelHub } from './hub.js';

/** 扫码授权的有效期:超过后需要在 Web 重新开始。 */
export const WECHAT_LOGIN_TTL_MS = 5 * 60 * 1000;
const QR_REQUEST_TIMEOUT_MS = 15_000;
const STATUS_POLL_TIMEOUT_MS = 45_000;

export const ilinkTokenKey = (channelId: string) => `ILINK_TOKEN_${channelId}`;

/** 平台给出的 API 地址与跳转地址只接受 https 的 *.qq.com,防止扫码结果把请求和令牌引到别处。 */
export function isAllowedIlinkUrl(url: URL): boolean {
    return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)qq\.com$/.test(url.hostname);
}

export interface WechatOptions {
    repos: Repositories;
    secrets: SecretStore;
    logger: Logger;
    /** 测试时指向假的 iLink 服务器。 */
    baseUrl?: string;
    allowUrl?: (url: URL) => boolean;
    fetch?: typeof fetch;
    now?: () => Date;
}

interface LoginSession {
    loginId: string;
    state: WechatLoginState;
    controller: AbortController;
}

export class WechatChannels {
    private readonly cursors = new Map<string, string>();
    private readonly logins = new Map<string, LoginSession>();
    private hub: ChannelHub | null = null;
    private readonly now: () => Date;
    private readonly allowUrl: (url: URL) => boolean;

    constructor(private readonly options: WechatOptions) {
        this.now = options.now ?? (() => new Date());
        this.allowUrl = options.allowUrl ?? isAllowedIlinkUrl;
    }

    /** 由服务器在创建 ChannelHub 之后调用;扫码成功后要按新令牌重启渠道。 */
    attach(hub: ChannelHub): void {
        this.hub = hub;
    }

    readonly factory: AdapterFactory = (channel) =>
        new WechatAdapter({
            tokenRef: channel.config.tokenRef ?? null,
            ...(channel.config.baseUrl ? { baseUrl: channel.config.baseUrl } : {}),
            cursor: {
                get: () => this.cursors.get(channel.id) ?? '',
                set: (value) => void this.cursors.set(channel.id, value),
            },
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });

    private client(baseUrl?: string): IlinkClient {
        return new IlinkClient({
            ...((baseUrl ?? this.options.baseUrl) ? { baseUrl: baseUrl ?? this.options.baseUrl } : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
    }

    /** 开始扫码;同一渠道再次开始会作废上一次。 */
    async startLogin(channel: ChannelRecord): Promise<WechatLoginStart> {
        this.cancelLogin(channel.id);
        let qr;
        try {
            qr = await this.client().getQrCode(AbortSignal.timeout(QR_REQUEST_TIMEOUT_MS));
        } catch (error) {
            const code = error instanceof IlinkError ? error.code : 'network';
            this.options.logger.warn({ channelId: channel.id, code }, 'wechat qr code request failed');
            throw new ApiError(502, 'provider_error', 'Bad Gateway', 'The WeChat service did not return a QR code.', {
                providerCode: code === 'network' ? 'network_error' : 'upstream_error',
            });
        }
        const session: LoginSession = {
            loginId: crypto.randomUUID(),
            state: { state: 'pending' },
            controller: new AbortController(),
        };
        this.logins.set(channel.id, session);
        const expiresAt = new Date(this.now().getTime() + WECHAT_LOGIN_TTL_MS);
        void this.watch(channel.id, session, qr.qrcode, expiresAt.getTime());
        return { loginId: session.loginId, qrContent: qr.qrContent, expiresAt: expiresAt.toISOString() };
    }

    loginState(channelId: string): WechatLoginState | null {
        return this.logins.get(channelId)?.state ?? null;
    }

    cancelLogin(channelId: string): void {
        this.logins.get(channelId)?.controller.abort();
        this.logins.delete(channelId);
    }

    /** 删除渠道时:取消扫码,忘掉游标,从 secrets.yaml 删除令牌(先备份、只删这一行)。 */
    forget(channelId: string): void {
        this.cancelLogin(channelId);
        this.cursors.delete(channelId);
        try {
            this.options.secrets.remove(ilinkTokenKey(channelId), this.now());
        } catch (error) {
            this.options.logger.warn(
                { channelId, code: (error as { code?: string }).code ?? 'error' },
                'could not remove the wechat token from secrets.yaml',
            );
        }
    }

    private async watch(channelId: string, session: LoginSession, qrcode: string, deadline: number): Promise<void> {
        const { signal } = session.controller;
        const finish = (state: WechatLoginState) => {
            session.state = state;
            session.controller.abort();
        };
        let client = this.client();
        while (!signal.aborted) {
            if (this.now().getTime() >= deadline) return finish({ state: 'expired' });
            let status;
            try {
                status = await client.getQrStatus(
                    qrcode,
                    AbortSignal.any([signal, AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS)]),
                );
            } catch {
                if (signal.aborted) return;
                // 协议说明:超时与网络错误按 wait 处理;稍等再轮询,避免对方立即报错时空转
                await new Promise((r) => setTimeout(r, 1000).unref());
                continue;
            }
            if (signal.aborted) return;
            switch (status.status) {
                case 'wait':
                    break;
                case 'scaned':
                    session.state = { state: 'scanned' };
                    break;
                case 'scaned_but_redirect': {
                    session.state = { state: 'scanned' };
                    if (status.redirectHost) {
                        const url = safeUrl(`https://${status.redirectHost}`);
                        if (!url || !this.allowUrl(url)) return finish({ state: 'failed', code: 'unexpected_host' });
                        client = this.client(url.origin);
                    }
                    break;
                }
                case 'expired':
                    return finish({ state: 'expired' });
                case 'confirmed':
                    return finish(await this.confirm(channelId, status.botToken, status.baseUrl));
                case 'binded_redirect':
                    return finish({ state: 'failed', code: 'already_bound' });
                case 'verify_code_blocked':
                    return finish({ state: 'failed', code: 'verify_code_blocked' });
                default:
                    // 需要在电脑上输入手机显示的数字(need_verifycode):1.0 先不支持,见 ADR 0024
                    if (status.status.includes('need_verifycode')) {
                        return finish({ state: 'failed', code: 'verify_code_required' });
                    }
            }
        }
    }

    private async confirm(channelId: string, token?: string, baseUrl?: string): Promise<WechatLoginState> {
        if (!token) return { state: 'failed', code: 'bad_response' };
        let origin: string | undefined;
        if (baseUrl) {
            const url = safeUrl(baseUrl);
            if (!url || !this.allowUrl(url)) return { state: 'failed', code: 'unexpected_host' };
            origin = url.origin;
        }
        const channel = this.options.repos.channels.byId(channelId);
        if (!channel) return { state: 'failed', code: 'channel_deleted' };
        try {
            this.options.secrets.write(ilinkTokenKey(channelId), token, this.now());
        } catch (error) {
            this.options.logger.warn({ channelId, code: 'secrets_write_failed' }, (error as Error).message);
            return { state: 'failed', code: 'secrets_write_failed' };
        }
        const config: Record<string, string> = { ...channel.config, tokenRef: `file:${ilinkTokenKey(channelId)}` };
        if (origin) config.baseUrl = origin;
        else delete config.baseUrl;
        this.options.repos.channels.setConfig(channelId, config);
        // 换了账号或令牌:从头收消息
        this.cursors.delete(channelId);
        this.options.logger.info({ channelId }, 'wechat login confirmed');
        const updated = this.options.repos.channels.byId(channelId);
        if (updated && this.hub) await this.hub.restart(updated);
        return { state: 'confirmed' };
    }
}

function safeUrl(text: string): URL | null {
    try {
        return new URL(text);
    } catch {
        return null;
    }
}

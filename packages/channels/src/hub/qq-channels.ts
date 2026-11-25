// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// QQ 官方机器人的服务器部分(ADR 0052 第 4 节):适配器工厂与凭据保存。
// AppSecret 按 ADR 0022 第 9 节写进 secrets.yaml 的 QQBOT_SECRET_<channelId>,渠道配置只记 AppID 与 file: 引用。
import type { SecretStore } from '@fatcat-ai/providers';
import { ServiceError, type QqCredentials } from '@fatcat-ai/shared';
import type { ChannelRecord, Repositories } from '@fatcat-ai/storage';
import { QqAdapter, type QqAdapterOptions } from '../qq.js';
import type { AdapterFactory, ChannelHub, ChannelLogger } from './hub.js';

export const qqSecretKey = (channelId: string) => `QQBOT_SECRET_${channelId}`;

export interface QqOptions {
    repos: Repositories;
    secrets: SecretStore;
    logger: ChannelLogger;
    /** 测试时指向假的 QQ 开放平台(地址、令牌接口、网关地址校验)。 */
    adapter?: Pick<QqAdapterOptions, 'apiBaseUrl' | 'tokenUrl' | 'allowGatewayUrl' | 'fetch' | 'WebSocket'>;
    now?: () => Date;
}

export class QqChannels {
    private hub: ChannelHub | null = null;
    private readonly now: () => Date;

    constructor(private readonly options: QqOptions) {
        this.now = options.now ?? (() => new Date());
    }

    /** 由服务器在创建 ChannelHub 之后调用;保存凭据后要重启渠道。 */
    attach(hub: ChannelHub): void {
        this.hub = hub;
    }

    readonly factory: AdapterFactory = (channel) =>
        new QqAdapter({
            appId: channel.config.appId ?? null,
            secretRef: channel.config.secretRef ?? null,
            ...this.options.adapter,
        });

    /** 保存凭据:AppSecret 写进 secrets.yaml(先备份、只改这一行),配置记 AppID 与引用,然后重启渠道。 */
    async saveCredentials(channel: ChannelRecord, credentials: QqCredentials): Promise<void> {
        try {
            this.options.secrets.write(qqSecretKey(channel.id), credentials.appSecret, this.now());
        } catch (error) {
            this.options.logger.warn(
                { channelId: channel.id, code: (error as { code?: string }).code ?? 'secrets_write_failed' },
                'could not write the qq secret to secrets.yaml',
            );
            throw new ServiceError(
                500,
                'internal',
                'Internal Server Error',
                'The AppSecret could not be saved to secrets.yaml; the file was not changed.',
            );
        }
        try {
            this.options.repos.channels.setConfig(channel.id, {
                ...channel.config,
                appId: credentials.appId,
                secretRef: `file:${qqSecretKey(channel.id)}`,
            });
        } catch (error) {
            // 配置没存上:删掉刚写的那一行,不留孤立的密钥
            this.forget(channel.id);
            throw error;
        }
        this.options.logger.info({ channelId: channel.id }, 'qq credentials saved');
        const updated = this.options.repos.channels.byId(channel.id);
        if (updated && this.hub) await this.hub.restart(updated);
    }

    /** 删除渠道时:从 secrets.yaml 删除 AppSecret(先备份、只删这一行);失败只记日志。 */
    forget(channelId: string): void {
        try {
            this.options.secrets.remove(qqSecretKey(channelId), this.now());
        } catch (error) {
            this.options.logger.warn(
                { channelId, code: (error as { code?: string }).code ?? 'error' },
                'could not remove the qq secret from secrets.yaml',
            );
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户停用、启用、删除时让运行中的部分跟上(ADR 0053 第 2 节):库里的凭据由 accounts 仓储作废,
// 这里关掉已建立的 WebSocket、停掉进行中的运行、停止渠道与 MCP 服务器、让定时任务重新排期;
// 删除时再从 secrets.yaml 删掉这个账户的密钥行(成员前缀 `U<ownerId>_` 与 QQ 渠道的 AppSecret)。
// 后台启动时的筛选(停用账户的任务、渠道、邮箱、MCP 不启动;MCP 只为管理员启动)在仓储的 SQL 里。
import type { RunManager } from '@fatcat-ai/agent';
import type { ChannelHub, QqChannels } from '@fatcat-ai/channels/hub';
import type { SecretStore } from '@fatcat-ai/providers';
import type { Repositories } from '@fatcat-ai/storage';
import { closeAccountSockets } from './device-sockets.js';
import type { McpControl } from './mcp-setup.js';
import type { Scheduler } from './scheduler-setup.js';

/** 成员写入 secrets.yaml 的键都带这个前缀(ADR 0053 第 5 节)。 */
export const memberSecretPrefix = (ownerId: string) => `U${ownerId}_`;

export interface AccountLifecycleDeps {
    repos: Repositories;
    runs: Pick<RunManager, 'stop'>;
    secrets: Pick<SecretStore, 'keyNames' | 'remove'>;
    channels?: Pick<ChannelHub, 'apply' | 'remove'> | undefined;
    qq?: Pick<QqChannels, 'forget'> | undefined;
    mcp?: Pick<McpControl, 'apply' | 'remove'> | undefined;
    scheduler?: Pick<Scheduler, 'engine' | 'syncWatchers'> | undefined;
    logger: { warn(fields: Record<string, unknown>, msg: string): void };
}

export class AccountLifecycle {
    constructor(private readonly deps: AccountLifecycleDeps) {}

    /** 停用之后(凭据已在库里作废):断开连接、停掉运行、渠道与 MCP,定时任务不再排期。 */
    async disabled(ownerId: string): Promise<void> {
        closeAccountSockets(ownerId);
        await this.stopRuntime(ownerId);
        this.reschedule();
    }

    /** 启用之后:按账户的设置重新启动渠道与 MCP,定时任务重新排期。旧凭据不恢复,要重新登录。 */
    async enabled(ownerId: string): Promise<void> {
        const { repos, channels } = this.deps;
        for (const channel of repos.channels.list(ownerId)) await channels?.apply(channel);
        await this.startMcp(ownerId);
        this.reschedule();
    }

    /**
     * 角色变了之后(ADR 0053 第 4 节):MCP 服务器只为管理员运行。降为成员时停掉它的 MCP 服务器(配置保留,
     * 不能再改),升为管理员时按配置启动。编码工具和嵌入在每次调用时按角色判断,不用这里处理。
     */
    async roleChanged(ownerId: string): Promise<void> {
        const { repos, mcp } = this.deps;
        if (repos.owners.get(ownerId)?.role === 'admin') await this.startMcp(ownerId);
        else for (const server of repos.mcpServers.list(ownerId)) mcp?.remove(server.id);
    }

    private async startMcp(ownerId: string): Promise<void> {
        const { repos, mcp } = this.deps;
        if (repos.owners.get(ownerId)?.role !== 'admin') return;
        for (const server of repos.mcpServers.list(ownerId)) {
            if (server.enabled) await mcp?.apply({ ...server, ownerId });
        }
    }

    /** 删除之前:断开、停掉一切,返回要在删除后清理的 QQ 渠道 id。 */
    async beforeDelete(ownerId: string): Promise<string[]> {
        closeAccountSockets(ownerId);
        const qqChannels = this.deps.repos.channels
            .list(ownerId)
            .filter((c) => c.kind === 'qq')
            .map((c) => c.id);
        await this.stopRuntime(ownerId);
        return qqChannels;
    }

    /** 删除之后:删掉 secrets.yaml 里这个账户的行(每行先备份、只删这一行);失败只记日志,不影响删除。 */
    afterDelete(ownerId: string, qqChannels: string[]): void {
        const { secrets, qq, logger } = this.deps;
        for (const id of qqChannels) qq?.forget(id);
        const prefix = memberSecretPrefix(ownerId);
        try {
            for (const name of secrets.keyNames().filter((n) => n.startsWith(prefix))) secrets.remove(name);
        } catch (error) {
            logger.warn(
                { ownerId, code: (error as { code?: string }).code ?? 'error' },
                'could not remove the account secrets from secrets.yaml',
            );
        }
        this.reschedule();
    }

    private async stopRuntime(ownerId: string): Promise<void> {
        const { repos, runs, channels, mcp } = this.deps;
        for (const run of repos.runs.listActive(ownerId)) await runs.stop(run.id);
        for (const channel of repos.channels.list(ownerId)) await channels?.remove(channel.id);
        for (const server of repos.mcpServers.list(ownerId)) mcp?.remove(server.id);
    }

    private reschedule(): void {
        this.deps.scheduler?.engine.rescheduleAll();
        this.deps.scheduler?.syncWatchers();
    }
}

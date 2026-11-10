// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 的按需加载(ADR 0013 第 4 节):没有配置任何 MCP 服务器时,不导入客户端代码。
import type { McpServerStatus } from '@ai-personal/shared';
import type { ToolRegistry } from '@ai-personal/tools';
import type { McpManager, OwnedMcpServer } from '@ai-personal/tools/mcp';

export interface McpControl {
    /** 连接(或重新连接)服务器并注册工具;禁用时只移除。 */
    apply(server: OwnedMcpServer): Promise<McpServerStatus>;
    remove(serverId: string): void;
    status(serverId: string): McpServerStatus;
    closeAll(): void;
}

export function createMcpControl(
    registry: ToolRegistry | undefined,
    options: { timeoutMs?: number; onError?: (error: unknown, context: { server: string }) => void } = {},
): McpControl {
    let manager: McpManager | null = null;
    let loading: Promise<McpManager> | null = null;
    const load = () => {
        if (!registry) return Promise.reject(new Error('tools are not enabled on this server'));
        loading ??= import('@ai-personal/tools/mcp').then(({ McpManager: Manager }) => {
            manager = new Manager({ registry, ...options });
            return manager;
        });
        return loading;
    };
    // 客户端代码加载期间,manager 还不知道这些服务器:状态先报 connecting
    const loadingIds = new Set<string>();
    return {
        apply: async (server) => {
            loadingIds.add(server.id);
            try {
                const loaded = await load();
                loadingIds.delete(server.id);
                return await loaded.apply(server);
            } finally {
                loadingIds.delete(server.id);
            }
        },
        remove: (serverId) => {
            loadingIds.delete(serverId);
            manager?.remove(serverId);
        },
        status: (serverId) =>
            loadingIds.has(serverId)
                ? { state: 'connecting', tools: [], error: null }
                : (manager?.status(serverId) ?? { state: 'disconnected', tools: [], error: null }),
        closeAll: () => manager?.closeAll(),
    };
}

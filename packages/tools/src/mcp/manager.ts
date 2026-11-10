// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 服务器管理(ADR 0013 第 3、4 节):连接已启用的服务器,把它们的工具作为一组注册进 ToolRegistry。
import type { McpServer, McpServerStatus, ToolRisk, UntrustedContent } from '@ai-personal/shared';
import type { ToolRegistry } from '../registry.js';
import type { ToolDefinition } from '../types.js';
import { ToolDeniedError } from '../types.js';
import { type McpCallResult, type McpToolInfo, StdioMcpClient } from './client.js';

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_RISK: ToolRisk = 'write';
/** 交给模型的结果文本上限(ADR 0013 第 5 节)。 */
export const MAX_RESULT_CHARS = 64_000;
const MAX_DESCRIPTION_CHARS = 1024;

/** 配置所属的 owner:工具执行时核对,别的 owner 的运行不能调用(ADR 0013 第 4 节)。 */
export type OwnedMcpServer = McpServer & { ownerId: string };

/** 把 MCP 工具名变成注册表允许的一段(只保留 [A-Za-z0-9_-]);太长时返回 null。 */
export function toolSegment(name: string): string | null {
    const segment = name.replace(/[^A-Za-z0-9_-]/g, '_');
    return TOOL_NAME.test(segment) ? segment : null;
}

/** 工具结果的文本:text 直接拼接,其他类型写一行占位说明。 */
export function resultText(result: McpCallResult): string {
    const parts = result.content ?? [];
    if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
    return parts
        .map((part) =>
            part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type} content omitted]`,
        )
        .join('\n');
}

interface Entry {
    server: OwnedMcpServer;
    client: StdioMcpClient | null;
    status: McpServerStatus;
}

export interface McpManagerOptions {
    registry: ToolRegistry;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onError?: (error: unknown, context: { server: string }) => void;
}

export class McpManager {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly options: McpManagerOptions) {}

    /** 连接(或重新连接)一个服务器并注册它的工具;禁用时只移除。 */
    async apply(server: OwnedMcpServer): Promise<McpServerStatus> {
        this.remove(server.id);
        const group = `mcp:${server.id}`;
        const entry: Entry = {
            server,
            client: null,
            status: { state: server.enabled ? 'connecting' : 'disabled', tools: [], error: null },
        };
        this.entries.set(server.id, entry);
        if (!server.enabled) return entry.status;

        const client = new StdioMcpClient(
            { command: server.command, args: server.args, cwd: server.cwd, envPassthrough: server.envPassthrough },
            {
                ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
                ...(this.options.env ? { env: this.options.env } : {}),
            },
        );
        entry.client = client;
        client.onClose = (reason) => {
            if (this.entries.get(server.id) !== entry) return;
            this.options.registry.replaceGroup(group, []);
            entry.status = {
                state: entry.status.state === 'connecting' ? 'error' : 'disconnected',
                tools: [],
                error: reason,
            };
        };
        try {
            await client.connect();
            const tools = await client.listTools();
            const definitions = tools.flatMap((t) => this.define(server, client, t));
            this.options.registry.replaceGroup(group, definitions);
            entry.status = { state: 'connected', tools: definitions.map((d) => d.name), error: null };
        } catch (error) {
            this.options.onError?.(error, { server: server.name });
            client.close();
            entry.status = { state: 'error', tools: [], error: error instanceof Error ? error.message : String(error) };
        }
        return entry.status;
    }

    status(serverId: string): McpServerStatus {
        return this.entries.get(serverId)?.status ?? { state: 'disconnected', tools: [], error: null };
    }

    /** 断开并移除一个服务器的工具。 */
    remove(serverId: string): void {
        const entry = this.entries.get(serverId);
        if (!entry) return;
        this.entries.delete(serverId);
        this.options.registry.replaceGroup(`mcp:${serverId}`, []);
        entry.client?.close();
    }

    closeAll(): void {
        for (const id of [...this.entries.keys()]) this.remove(id);
    }

    private define(server: OwnedMcpServer, client: StdioMcpClient, tool: McpToolInfo): ToolDefinition[] {
        const segment = typeof tool.name === 'string' ? toolSegment(tool.name) : null;
        if (!segment) return [];
        const name = `mcp.${server.name}.${segment}`;
        const risk = server.toolRisks[tool.name] ?? server.toolRisks[segment] ?? DEFAULT_RISK;
        return [
            {
                name,
                description:
                    `${(tool.description ?? '').slice(0, MAX_DESCRIPTION_CHARS)} (MCP server "${server.name}")`.trim(),
                parameters:
                    tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
                risk,
                source: 'mcp',
                server: server.name,
                untrustedOutput: true,
                summarize: (input) => {
                    const args = JSON.stringify(input ?? {});
                    return `${server.name}: ${tool.name} ${args.length > 200 ? `${args.slice(0, 199)}…` : args}`;
                },
                execute: async (input, context) => {
                    if (context.ownerId !== server.ownerId) {
                        throw new ToolDeniedError('This MCP server belongs to another account.');
                    }
                    const result = await client.callTool(tool.name, input);
                    // 错误文本同样来自服务器:包成不可信内容,不作为异常抛出(ADR 0013 第 5 节)
                    const text = result.isError
                        ? `[The MCP tool reported an error]\n${resultText(result)}`
                        : resultText(result);
                    const output: UntrustedContent = {
                        untrusted: true,
                        source: { kind: 'mcp', ref: name },
                        content: text.slice(0, MAX_RESULT_CHARS),
                        truncated: text.length > MAX_RESULT_CHARS,
                    };
                    return output;
                },
            },
        ];
    }
}

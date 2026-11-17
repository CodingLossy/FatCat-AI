// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件 SDK(ADR 0040 第 1 节):一个自带最小 stdio MCP 服务端的构建器。
// 标准 MCP 方法(initialize / tools/list / tools/call / ping)之外,支持 fatcat/items.* 的提供者回调,
// 并向主程序发 fatcat/net.fetch、fatcat/items.upsert、fatcat/log 与每 30 秒一次的 fatcat/heartbeat。
// 主程序只会响应清单里声明过的能力;SDK 不替插件做授权判断。
import {
    FATCAT_METHODS,
    ItemsChildrenParams,
    ItemsListResult,
    ItemsOpenParams,
    ItemsOpenResult,
    ItemsRootsParams,
    ItemsUpsertResult,
    NetFetchResult,
    PluginToolName,
    PLUGIN_RPC_ERRORS,
    type PluginItemNode,
} from '@fatcat-ai/shared';
import { PluginRpcError, RpcConnection } from './rpc.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface PluginOptions {
    /** 出现在 MCP `serverInfo` 里;通常与 plugin.json 的 id、version 一致。 */
    name: string;
    version: string;
}

export interface ToolResult {
    content: { type: 'text'; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
}

export interface ToolDefinition {
    /** 与 plugin.json 的 permissions.tools 里的 name 一致,否则主程序不注册。 */
    name: string;
    description: string;
    /** JSON Schema;原样交给主程序和模型。 */
    inputSchema?: Record<string, unknown>;
    /** 返回字符串会被包成一段文本;抛出的错误会变成 `isError` 结果(只带 message,不带堆栈)。 */
    handler: (args: Record<string, unknown>, ctx: PluginContext) => Promise<string | ToolResult> | string | ToolResult;
}

export interface ItemProvider {
    /** 与 plugin.json 的 permissions.items.categories 里的 type 一致。 */
    type: string;
    roots: (ctx: PluginContext) => Promise<PluginItemNode[]> | PluginItemNode[];
    children?: (
        parentId: string,
        ctx: PluginContext,
        cursor?: string,
    ) => Promise<{ items: PluginItemNode[]; nextCursor?: string }> | { items: PluginItemNode[]; nextCursor?: string };
    open?: (
        id: string,
        ctx: PluginContext,
    ) => Promise<{ title: string; content: string; url?: string }> | { title: string; content: string; url?: string };
}

export interface FetchInit {
    method?: 'GET' | 'HEAD' | 'POST';
    headers?: Record<string, string>;
    body?: string;
}

export interface FetchResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    /** 响应体超过主程序的上限被截断。 */
    truncated: boolean;
    text(): string;
    json(): unknown;
    bytes(): Uint8Array;
}

export interface PluginContext {
    /** 经主程序代发的请求(`fatcat/net.fetch`):域名范围和 SSRF 防护都在主程序一侧。 */
    fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
    /** 清单里声明并由用户绑定的密钥;没绑定返回 undefined。 */
    secret(name: string): string | undefined;
    /** 插件的数据目录(唯一可写的位置)。 */
    readonly dataDir: string | undefined;
    items: { upsert(items: (PluginItemNode & { parentId?: string })[]): Promise<number> };
}

export interface RunOptions {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    env?: NodeJS.ProcessEnv;
    heartbeatMs?: number;
    /** 读取常驻内存(字节);默认 `process.memoryUsage.rss()`。 */
    rss?: () => number;
}

export interface Plugin {
    registerTool(tool: ToolDefinition): void;
    registerItemProvider(provider: ItemProvider): void;
    /** 启动 stdio 服务;宿主关闭 stdin 后 resolve。 */
    run(options?: RunOptions): Promise<void>;
}

/** 创建一个插件。先 `registerTool` / `registerItemProvider`,最后 `await plugin.run()`。 */
export function definePlugin(options: PluginOptions): Plugin {
    const tools = new Map<string, ToolDefinition>();
    const providers = new Map<string, ItemProvider>();

    return {
        registerTool(tool) {
            if (!PluginToolName.safeParse(tool.name).success) throw new Error(`invalid tool name "${tool.name}"`);
            if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
            tools.set(tool.name, tool);
        },
        registerItemProvider(provider) {
            if (providers.has(provider.type)) throw new Error(`item provider "${provider.type}" is already registered`);
            providers.set(provider.type, provider);
        },
        async run(run = {}) {
            const env = run.env ?? process.env;
            // eslint-disable-next-line prefer-const -- connection 与 ctx 互相引用
            let connection: RpcConnection;
            const ctx: PluginContext = {
                async fetch(url, init = {}) {
                    const result = NetFetchResult.parse(
                        await connection.request(FATCAT_METHODS.netFetch, { url, ...init }),
                    );
                    const bytes = (): Uint8Array =>
                        result.bodyEncoding === 'base64'
                            ? new Uint8Array(Buffer.from(result.body, 'base64'))
                            : new TextEncoder().encode(result.body);
                    const text = (): string =>
                        result.bodyEncoding === 'utf8' ? result.body : new TextDecoder().decode(bytes());
                    return {
                        status: result.status,
                        ok: result.status >= 200 && result.status < 300,
                        headers: result.headers,
                        truncated: result.truncated,
                        text,
                        json: () => JSON.parse(text()) as unknown,
                        bytes,
                    };
                },
                log(level, message, fields) {
                    connection.notify(FATCAT_METHODS.log, { level, message, ...(fields ? { fields } : {}) });
                },
                secret(name) {
                    const value = env[name];
                    return value === undefined || value === '' ? undefined : value;
                },
                dataDir: env.FATCAT_PLUGIN_DATA,
                items: {
                    async upsert(items) {
                        const result = ItemsUpsertResult.parse(
                            await connection.request(FATCAT_METHODS.itemsUpsert, { items }),
                        );
                        return result.upserted;
                    },
                },
            };

            let heartbeat: ReturnType<typeof setInterval> | undefined;
            const startHeartbeat = (): void => {
                if (heartbeat) return;
                const beat = (): void =>
                    connection.notify(FATCAT_METHODS.heartbeat, {
                        rss: Math.round((run.rss ?? process.memoryUsage.rss)()),
                    });
                beat();
                heartbeat = setInterval(beat, run.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
                heartbeat.unref();
            };

            const invalid = (message: string): PluginRpcError =>
                new PluginRpcError('invalid_params', message, PLUGIN_RPC_ERRORS.invalid_params);
            const providerFor = (type: string): ItemProvider => {
                const provider = providers.get(type);
                if (!provider) throw invalid(`no item provider for "${type}"`);
                return provider;
            };

            connection = new RpcConnection(
                run.input ?? process.stdin,
                run.output ?? process.stdout,
                async (method, params) => {
                    switch (method) {
                        case 'initialize': {
                            const asked = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
                            startHeartbeat();
                            return {
                                protocolVersion: typeof asked === 'string' ? asked : MCP_PROTOCOL_VERSION,
                                capabilities: {
                                    tools: {},
                                    experimental: { fatcat: { version: 1, items: providers.size > 0 } },
                                },
                                serverInfo: { name: options.name, version: options.version },
                            };
                        }
                        case 'ping':
                            return {};
                        case 'tools/list':
                            return {
                                tools: [...tools.values()].map((tool) => ({
                                    name: tool.name,
                                    description: tool.description,
                                    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
                                })),
                            };
                        case 'tools/call': {
                            const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
                            const tool = typeof call.name === 'string' ? tools.get(call.name) : undefined;
                            if (!tool) throw invalid('unknown tool');
                            const args =
                                call.arguments !== null &&
                                typeof call.arguments === 'object' &&
                                !Array.isArray(call.arguments)
                                    ? (call.arguments as Record<string, unknown>)
                                    : {};
                            try {
                                const result = await tool.handler(args, ctx);
                                return typeof result === 'string'
                                    ? { content: [{ type: 'text', text: result }] }
                                    : result;
                            } catch (error) {
                                const text = error instanceof Error ? error.message : 'the tool failed';
                                return { content: [{ type: 'text', text }], isError: true };
                            }
                        }
                        case FATCAT_METHODS.itemsRoots: {
                            const parsed = ItemsRootsParams.safeParse(params ?? {});
                            if (!parsed.success) throw invalid('invalid params');
                            const selected = parsed.data.type
                                ? [providerFor(parsed.data.type)]
                                : [...providers.values()];
                            const items = (await Promise.all(selected.map((p) => p.roots(ctx)))).flat();
                            return ItemsListResult.parse({ items });
                        }
                        case FATCAT_METHODS.itemsChildren: {
                            const parsed = ItemsChildrenParams.safeParse(params);
                            if (!parsed.success) throw invalid('invalid params');
                            const provider = providerFor(parsed.data.type);
                            if (!provider.children) return { items: [] };
                            return ItemsListResult.parse(
                                await provider.children(parsed.data.parentId, ctx, parsed.data.cursor),
                            );
                        }
                        case FATCAT_METHODS.itemsOpen: {
                            const parsed = ItemsOpenParams.safeParse(params);
                            if (!parsed.success) throw invalid('invalid params');
                            const provider = providerFor(parsed.data.type);
                            if (!provider.open) throw invalid('this provider cannot open items');
                            return ItemsOpenResult.parse(await provider.open(parsed.data.id, ctx));
                        }
                        default:
                            throw new PluginRpcError('method_not_found', `method not found: ${method}`);
                    }
                },
                () => undefined,
            );
            try {
                await connection.run();
            } finally {
                if (heartbeat) clearInterval(heartbeat);
            }
        },
    };
}

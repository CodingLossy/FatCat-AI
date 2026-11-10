// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 最小的 MCP stdio 客户端(ADR 0013 第 2 节):按行分隔的 JSON-RPC 2.0,只实现 initialize、tools/list 与 tools/call。
// 不经过 shell 启动;子进程只拿到最小环境与用户允许传递的变量。
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { isOwnEnvName } from '@fatcat-ai/shared';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const REQUEST_TIMEOUT_MS = 30_000;
/** 单行(一条消息)的上限;超出时断开连接。 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL = 4096;

export class McpError extends Error {
    override readonly name = 'McpError';
}

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
    content?: { type: string; text?: string; [key: string]: unknown }[];
    structuredContent?: unknown;
    isError?: boolean;
}

export interface StdioServerConfig {
    command: string;
    args: string[];
    cwd?: string | null | undefined;
    /** 允许传给子进程的环境变量名字(值取自当前进程的环境)。 */
    envPassthrough: string[];
}

/** 子进程的最小环境:运行程序所需的少数变量,加上用户明确允许传递的变量。 */
export function childEnv(passthrough: readonly string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const base = [
        'PATH',
        'Path',
        'HOME',
        'USERPROFILE',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SYSTEMROOT',
        'SystemRoot',
        'PATHEXT',
        'APPDATA',
        'LOCALAPPDATA',
    ];
    const out: Record<string, string> = {};
    // 本服务自己的配置(FATCAT_AI_*,以及改名前的 AIP_*)永远不传给子进程,即使用户写了
    for (const name of [...base, ...passthrough.filter((n) => !isOwnEnvName(n))]) {
        const value = env[name];
        if (value !== undefined) out[name] = value;
    }
    return out;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class StdioMcpClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private buffer = '';
    private stderr = '';
    private closed = false;
    /** 连接断开时调用(进程退出、协议错误)。 */
    onClose?: (reason: string) => void;

    constructor(
        private readonly config: StdioServerConfig,
        private readonly options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
    ) {}

    /** 启动子进程并完成握手。 */
    async connect(): Promise<void> {
        const child = spawn(this.config.command, this.config.args, {
            cwd: this.config.cwd ?? undefined,
            env: childEnv(this.config.envPassthrough, this.options.env),
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => this.onData(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
        });
        child.on('error', (error) => this.fail(`could not start the server: ${error.message}`));
        child.on('exit', (code, signal) => this.fail(`the server exited (${signal ?? `code ${code}`})`));
        child.stdin.on('error', () => undefined);

        await this.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'FatCat-AI', version: '0.0.0' },
        });
        this.notify('notifications/initialized');
    }

    /** 列出全部工具(按 nextCursor 翻页)。 */
    async listTools(): Promise<McpToolInfo[]> {
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
            const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
                tools?: McpToolInfo[];
                nextCursor?: string;
            };
            tools.push(...(result.tools ?? []));
            cursor = result.nextCursor;
            if (!cursor) break;
        }
        return tools;
    }

    callTool(name: string, args: unknown): Promise<McpCallResult> {
        return this.request('tools/call', { name, arguments: args ?? {} }) as Promise<McpCallResult>;
    }

    /** 最近的 stderr 输出(报错时附上,便于排查;不写日志)。 */
    get stderrTail(): string {
        return this.stderr.trim();
    }

    close(): void {
        if (this.closed) return;
        this.fail('the client was closed');
    }

    private request(method: string, params: unknown): Promise<unknown> {
        if (this.closed || !this.child) return Promise.reject(new McpError('the MCP server is not connected'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new McpError(`${method} timed out`));
            }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    private notify(method: string): void {
        this.write({ jsonrpc: '2.0', method });
    }

    private write(message: unknown): void {
        this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
            this.fail('the server sent a message that is too large');
            return;
        }
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this.onMessage(line);
        }
    }

    private onMessage(line: string): void {
        let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
        try {
            message = JSON.parse(line) as typeof message;
        } catch {
            return; // 服务器偶尔会把日志写到 stdout:忽略无法解析的行
        }
        if (message.method !== undefined) {
            // 服务器发来的请求(如 sampling):不支持;通知:忽略
            if (message.id !== undefined) {
                this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
            }
            return;
        }
        if (typeof message.id !== 'number') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new McpError(message.error.message ?? 'the MCP server returned an error'));
        else pending.resolve(message.result);
    }

    private fail(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new McpError(this.stderr ? `${reason}: ${this.stderrTail.slice(-500)}` : reason));
            this.pending.delete(id);
        }
        const child = this.child;
        if (child && child.exitCode === null && !child.killed) child.kill();
        this.onClose?.(reason);
    }
}

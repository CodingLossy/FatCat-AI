// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 最小的 JSON-RPC 2.0 over stdio(按行分隔,与 MCP stdio 传输一致,ADR 0040 第 1 节)。
// 自写以避免引入 @modelcontextprotocol/sdk;只实现插件需要的部分:收请求 / 通知,发请求 / 通知。
import { PLUGIN_RPC_ERRORS, type PluginRpcErrorCode } from '@fatcat-ai/shared';

/** 单行(一条消息)的上限,与宿主一致;超出时断开连接。 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class PluginRpcError extends Error {
    override readonly name = 'PluginRpcError';
    constructor(
        readonly code: PluginRpcErrorCode | 'internal_error',
        message: string,
        readonly rpcCode: number = code === 'internal_error' ? -32603 : PLUGIN_RPC_ERRORS[code],
    ) {
        super(message);
    }
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Message {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown; data?: unknown };
}

function codeFromRpc(rpcCode: unknown, data: unknown): PluginRpcErrorCode | 'internal_error' {
    const named = (data as { code?: unknown } | null | undefined)?.code;
    if (typeof named === 'string' && named in PLUGIN_RPC_ERRORS) return named as PluginRpcErrorCode;
    for (const [name, value] of Object.entries(PLUGIN_RPC_ERRORS)) {
        if (value === rpcCode) return name as PluginRpcErrorCode;
    }
    return 'internal_error';
}

export class RpcConnection {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private buffer = '';
    private closed = false;

    constructor(
        private readonly input: NodeJS.ReadableStream,
        private readonly output: NodeJS.WritableStream,
        private readonly onRequest: RequestHandler,
        private readonly onNotification: NotificationHandler,
        private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ) {}

    /** 开始读取;输入结束(宿主关闭 stdin)或协议错误时 resolve。 */
    run(): Promise<void> {
        return new Promise((resolve) => {
            this.input.setEncoding?.('utf8');
            this.input.on('data', (chunk: string | Buffer) => {
                this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                let newline: number;
                while ((newline = this.buffer.indexOf('\n')) >= 0) {
                    const line = this.buffer.slice(0, newline).trim();
                    this.buffer = this.buffer.slice(newline + 1);
                    if (line) this.handleLine(line);
                }
                if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
                    this.close('message too large');
                    resolve();
                }
            });
            const end = (): void => {
                this.close('input closed');
                resolve();
            };
            this.input.on('end', end);
            this.input.on('close', end);
            this.input.on('error', end);
        });
    }

    request(method: string, params: unknown): Promise<unknown> {
        if (this.closed) return Promise.reject(new PluginRpcError('internal_error', 'the host connection is closed'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new PluginRpcError('internal_error', `${method} timed out`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
    }

    close(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new PluginRpcError('internal_error', reason));
            this.pending.delete(id);
        }
    }

    private send(message: object): void {
        this.output.write(`${JSON.stringify(message)}\n`);
    }

    private handleLine(line: string): void {
        let message: Message;
        try {
            message = JSON.parse(line) as Message;
        } catch {
            // 解析不了的行没有 id 可回,按 JSON-RPC 回 parse error
            this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
            return;
        }
        if (typeof message.method === 'string') {
            if (message.id === undefined || message.id === null) {
                try {
                    this.onNotification(message.method, message.params);
                } catch {
                    // 通知没有应答,处理失败只能忽略
                }
                return;
            }
            void this.answer(message.id, message.method, message.params);
            return;
        }
        if (typeof message.id === 'number') {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                const text = typeof message.error.message === 'string' ? message.error.message : 'request failed';
                const code = codeFromRpc(message.error.code, message.error.data);
                entry.reject(
                    new PluginRpcError(
                        code,
                        text,
                        typeof message.error.code === 'number' ? message.error.code : undefined,
                    ),
                );
            } else {
                entry.resolve(message.result);
            }
        }
    }

    private async answer(id: unknown, method: string, params: unknown): Promise<void> {
        try {
            const result = await this.onRequest(method, params);
            this.send({ jsonrpc: '2.0', id, result: result ?? {} });
        } catch (error) {
            if (error instanceof PluginRpcError) {
                this.send({
                    jsonrpc: '2.0',
                    id,
                    error: { code: error.rpcCode, message: error.message, data: { code: error.code } },
                });
            } else {
                this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } });
            }
        }
    }
}

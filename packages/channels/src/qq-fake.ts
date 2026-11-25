// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 假的 QQ 开放平台(只用于测试,经 @fatcat-ai/channels/testing 导入):令牌接口、网关地址、发单聊消息,
// 以及一个最小的 WebSocket 网关(握手 + 不分片的文本帧 + 关闭帧),不连任何真实服务,也不引入依赖。
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakeQqFrame {
    op: number;
    d?: unknown;
    s?: number | null;
    t?: string | null;
}

export interface FakeQqSent {
    openid: string;
    body: { content?: string; msg_type?: number; msg_id?: string; msg_seq?: number };
    authorization: string | undefined;
}

export class FakeQqConnection {
    readonly received: FakeQqFrame[] = [];
    closed = false;
    private buffer = Buffer.alloc(0);
    private waiters: (() => void)[] = [];

    constructor(private readonly socket: Socket) {
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('close', () => {
            this.closed = true;
            this.wake();
        });
        socket.on('error', () => undefined);
    }

    send(frame: FakeQqFrame): void {
        if (this.closed) return;
        const payload = Buffer.from(JSON.stringify(frame));
        this.socket.write(Buffer.concat([header(0x1, payload.length), payload]));
    }

    /** 发关闭帧并断开。 */
    close(code: number): void {
        if (this.closed) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code);
        this.socket.write(Buffer.concat([header(0x8, 2), payload]));
        this.socket.end();
        this.closed = true;
    }

    /** 等到客户端发来满足条件的帧。 */
    async waitFor(test: (frame: FakeQqFrame) => boolean, timeoutMs = 3000): Promise<FakeQqFrame> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.received.find(test);
            if (found) return found;
            if (this.closed) throw new Error('the connection closed');
            if (Date.now() > deadline) throw new Error('timed out waiting for a frame');
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 20);
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    private wake(): void {
        for (const w of this.waiters.splice(0)) w();
    }

    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.buffer.length < 2) return;
            const opcode = this.buffer[0]! & 0x0f;
            const masked = (this.buffer[1]! & 0x80) !== 0;
            let length = this.buffer[1]! & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4) return;
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffer.length < 10) return;
                length = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }
            const maskOffset = offset;
            if (masked) offset += 4;
            if (this.buffer.length < offset + length) return;
            const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
            if (masked) {
                for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buffer[maskOffset + (i % 4)]!;
            }
            this.buffer = this.buffer.subarray(offset + length);
            if (opcode === 0x8) {
                this.socket.end();
                this.closed = true;
                this.wake();
                return;
            }
            if (opcode === 0x1) {
                try {
                    this.received.push(JSON.parse(payload.toString('utf8')) as FakeQqFrame);
                } catch {
                    // 忽略不是 JSON 的帧
                }
                this.wake();
            }
        }
    }
}

function header(opcode: number, length: number): Buffer {
    if (length < 126) return Buffer.from([0x80 | opcode, length]);
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(length, 2);
    return h;
}

export interface FakeQqOptions {
    appId?: string;
    appSecret?: string;
    /** 令牌有效期(秒)。 */
    expiresIn?: number;
    /** 网关接口返回的地址;默认是本服务器的 /websocket。 */
    gatewayUrl?: (self: string) => string;
    /** 发消息时按顺序返回的错误(HTTP 状态码 + 平台错误码);用完后都成功。 */
    sendErrors?: { status: number; code: number }[];
}

/** 本机的假 QQ 开放平台。 */
export class FakeQqPlatform {
    readonly sent: FakeQqSent[] = [];
    readonly connections: FakeQqConnection[] = [];
    tokenRequests = 0;
    /** 连上之后自动发的 Hello。 */
    heartbeatInterval = 45_000;
    private server: Server | null = null;
    private origin = '';
    private issued = 0;

    constructor(private readonly options: FakeQqOptions = {}) {}

    get apiBaseUrl(): string {
        return this.origin;
    }

    get tokenUrl(): string {
        return `${this.origin}/app/getAppAccessToken`;
    }

    /** 最近一次发出的令牌。 */
    get currentToken(): string {
        return `fake-access-token-${this.issued}`;
    }

    async listen(): Promise<void> {
        this.server = createServer((req, res) => {
            void this.handle(req).then(({ status, body }) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            });
        });
        this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
            const key = req.headers['sec-websocket-key'];
            if (req.url?.split('?')[0] !== '/websocket' || typeof key !== 'string') {
                socket.destroy();
                return;
            }
            const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            const connection = new FakeQqConnection(socket);
            this.connections.push(connection);
            connection.send({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } });
        });
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
        const { port } = this.server.address() as AddressInfo;
        this.origin = `http://127.0.0.1:${port}`;
    }

    async close(): Promise<void> {
        for (const c of this.connections) c.close(1001);
        await new Promise<void>((resolve) => {
            this.server?.closeAllConnections();
            this.server?.close(() => resolve());
        });
    }

    /** 等到第 n 个(从 1 起)连接建立。 */
    async connection(n = 1, timeoutMs = 3000): Promise<FakeQqConnection> {
        const deadline = Date.now() + timeoutMs;
        while (this.connections.length < n) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for connection ${n}`);
            await new Promise((r) => setTimeout(r, 10));
        }
        return this.connections[n - 1]!;
    }

    private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        const url = req.url ?? '';
        if (req.method === 'POST' && url === '/app/getAppAccessToken') {
            this.tokenRequests += 1;
            const body = JSON.parse(text || '{}') as { appId?: string; clientSecret?: string };
            if (
                body.appId !== (this.options.appId ?? '102030') ||
                body.clientSecret !== (this.options.appSecret ?? 'app-secret-value')
            ) {
                return { status: 200, body: { code: 100016, message: 'invalid appid or secret' } };
            }
            this.issued += 1;
            return {
                status: 200,
                body: { access_token: this.currentToken, expires_in: String(this.options.expiresIn ?? 7200) },
            };
        }
        if (req.headers.authorization !== `QQBot ${this.currentToken}`) {
            return { status: 401, body: { code: 11241, message: 'token invalid' } };
        }
        if (req.method === 'GET' && url === '/gateway/bot') {
            const ws = this.origin.replace(/^http/, 'ws');
            return { status: 200, body: { url: this.options.gatewayUrl?.(ws) ?? `${ws}/websocket`, shards: 1 } };
        }
        const match = /^\/v2\/users\/([^/]+)\/messages$/.exec(url);
        if (req.method === 'POST' && match) {
            const error = this.options.sendErrors?.shift();
            if (error) return { status: error.status, body: { code: error.code, message: 'fake error' } };
            this.sent.push({
                openid: decodeURIComponent(match[1]!),
                body: JSON.parse(text) as FakeQqSent['body'],
                authorization: req.headers.authorization,
            });
            return { status: 200, body: { id: `sent-${this.sent.length}`, timestamp: new Date().toISOString() } };
        }
        return { status: 404, body: { code: 404, message: 'not found' } };
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 客户端执行的工具调用(ADR 0046 第 3.6、14 节):核心没有渲染引擎,截图由已连接的桌面客户端完成。
// 这里只管三件事:记录哪些 WebSocket 连接声明了能力、给它们发 client-call 帧、等 POST /tool-calls/{id}/result 回来。
// 全部在内存里:核心重启后进行中的调用直接失败(对应的工具调用本来也随运行一起结束)。
import { randomBytes } from 'node:crypto';
import {
    CLIENT_CALL_IMAGE_MAX_BYTES,
    type ClientCall,
    type ClientCallResult,
    type ClientCapabilities,
} from '@fatcat-ai/shared';
import { BrowserError, type BrowserHost, type ScreenshotImage } from '@fatcat-ai/tools';

/** 一次调用最长等多久(毫秒)。ADR:默认 30 秒;截图要先加载页面,给 20 秒。 */
export const CLIENT_CALL_TIMEOUT_MS = 20_000;
const MAX_PENDING_PER_OWNER = 4;
const RECENT_DONE = 200;

/** 一个已声明能力的连接:收到调用时执行 send。 */
export interface ClientSocket {
    send(call: ClientCall): void;
}

export type CompleteOutcome = 'ok' | 'not_found' | 'conflict';

interface Pending {
    ownerId: string;
    resolve(result: ClientCallResult): void;
}

export class ClientCalls {
    private readonly sockets = new Map<string, Map<ClientSocket, ClientCapabilities>>();
    private readonly pending = new Map<string, Pending>();
    /** 最近结束(完成、超时、取消)的调用 id:再来结果时回 409 而不是 404。 */
    private readonly done = new Set<string>();

    constructor(private readonly now: () => number = Date.now) {}

    /** 登记一个连接,返回设置能力与注销的函数。能力默认全关。 */
    register(ownerId: string, socket: ClientSocket): { declare(caps: ClientCapabilities): void; unregister(): void } {
        const set = this.sockets.get(ownerId) ?? new Map<ClientSocket, ClientCapabilities>();
        this.sockets.set(ownerId, set);
        set.set(socket, { browser: false });
        return {
            declare: (caps) => {
                if (set.has(socket)) set.set(socket, caps);
            },
            unregister: () => {
                set.delete(socket);
                if (set.size === 0 && this.sockets.get(ownerId) === set) this.sockets.delete(ownerId);
            },
        };
    }

    /** 本人是否有声明了浏览器能力的连接。 */
    hasBrowser(ownerId: string): boolean {
        return [...(this.sockets.get(ownerId)?.values() ?? [])].some((caps) => caps.browser);
    }

    /**
     * 发出一次调用并等结果。没有可用连接、同时进行的太多、超时、被取消都以 BrowserError 失败,
     * 不会悄悄改用别的方式(ADR 0046 第 3.1 节)。
     */
    request(
        ownerId: string,
        call: Pick<ClientCall, 'tool' | 'url'>,
        options: { signal: AbortSignal; timeoutMs?: number },
    ): Promise<ClientCallResult> {
        const targets = [...(this.sockets.get(ownerId)?.entries() ?? [])].filter(([, caps]) => caps.browser);
        if (targets.length === 0) {
            return Promise.reject(
                new BrowserError('the desktop app is not connected (browser_unavailable)', 'browser_unavailable'),
            );
        }
        let inFlight = 0;
        for (const p of this.pending.values()) if (p.ownerId === ownerId) inFlight += 1;
        if (inFlight >= MAX_PENDING_PER_OWNER) {
            return Promise.reject(new BrowserError('too many client calls in progress', 'busy'));
        }
        const timeoutMs = options.timeoutMs ?? CLIENT_CALL_TIMEOUT_MS;
        const callId = `cc_${randomBytes(18).toString('base64url')}`;
        const frame: ClientCall = {
            callId,
            tool: call.tool,
            url: call.url,
            expiresAt: new Date(this.now() + timeoutMs).toISOString(),
        };
        return new Promise<ClientCallResult>((resolve, reject) => {
            const finish = (): void => {
                clearTimeout(timer);
                options.signal.removeEventListener('abort', onAbort);
                this.pending.delete(callId);
                this.remember(callId);
            };
            const timer = setTimeout(() => {
                finish();
                reject(new BrowserError('the desktop app did not answer in time', 'timeout'));
            }, timeoutMs);
            const onAbort = (): void => {
                finish();
                reject(new BrowserError('the client call was cancelled', 'timeout'));
            };
            if (options.signal.aborted) return onAbort();
            options.signal.addEventListener('abort', onAbort, { once: true });
            this.pending.set(callId, {
                ownerId,
                resolve: (result) => {
                    finish();
                    resolve(result);
                },
            });
            for (const [socket] of targets) {
                try {
                    socket.send(frame);
                } catch {
                    // 某个连接发不出去时由其他连接或超时兜底
                }
            }
        });
    }

    /** 收到客户端的结果。别人的调用、未知的调用都当作不存在(404);已结束或重复的是 409。 */
    complete(ownerId: string, callId: string, result: ClientCallResult): CompleteOutcome {
        const pending = this.pending.get(callId);
        if (!pending || pending.ownerId !== ownerId) {
            return this.done.has(callId) && !pending ? 'conflict' : 'not_found';
        }
        pending.resolve(result);
        return 'ok';
    }

    private remember(callId: string): void {
        this.done.add(callId);
        if (this.done.size > RECENT_DONE) this.done.delete(this.done.values().next().value!);
    }
}

function decodedBytes(base64: string): number {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasSignature(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg'): boolean {
    const signature = mimeType === 'image/png' ? PNG_SIGNATURE : [0xff, 0xd8, 0xff];
    return signature.every((byte, i) => bytes[i] === byte);
}

/** 页面文字用的失败原因对照:壳返回的稳定码 → 工具错误码。 */
const FAILURE_CODES: Record<string, string> = {
    unsupported: 'browser_unavailable',
    blocked: 'blocked_address',
    timeout: 'timeout',
    load_failed: 'http_error',
    too_large: 'too_large',
    failed: 'browser_unavailable',
};

/** 宿主适配器:把 browser.screenshot 交给本人已连接的桌面客户端。 */
export function createClientBrowserHost(calls: ClientCalls): BrowserHost {
    return {
        async screenshot(url, signal, context): Promise<ScreenshotImage> {
            const result = await calls.request(context.ownerId, { tool: 'browser.screenshot', url }, { signal });
            if (!result.ok) {
                throw new BrowserError(
                    result.message ?? `the desktop app could not take the screenshot (${result.code})`,
                    FAILURE_CODES[result.code] ?? 'browser_unavailable',
                );
            }
            const bytes = decodedBytes(result.data);
            if (bytes > CLIENT_CALL_IMAGE_MAX_BYTES) throw new BrowserError('the screenshot is too large', 'too_large');
            const image = Buffer.from(result.data, 'base64');
            // 客户端是可信的,但不信它的声明:字节必须真的是它说的图像格式
            if (!hasSignature(image, result.mimeType)) {
                throw new BrowserError('the screenshot is not a valid image', 'browser_unavailable');
            }
            return { mimeType: result.mimeType, width: result.width, height: result.height, bytes: image };
        },
    };
}

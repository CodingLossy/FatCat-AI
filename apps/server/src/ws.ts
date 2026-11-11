// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { assistantLabel, type EventBus } from '@fatcat-ai/agent';
import {
    ClientFrame,
    type EventEnvelope,
    MAX_VOICE_STATE_FRAMES_PER_SECOND,
    PROTOCOL_VERSION,
    type ServerFrame,
    type VoiceStateReport,
    WS_PING_INTERVAL_MS,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import type { WebSocket, WebSocketServer } from 'ws';
import { PAT_PREFIX, safeEqual, sha256 } from './auth/crypto.js';
import { SESSION_COOKIE } from './auth/middleware.js';
import type { Logger } from './log.js';
import { SERVER_VERSION } from './version.js';
import { WindowLimiter } from './voice-limit.js';

export const WS_PATH = '/api/v1/ws';
const HELLO_TIMEOUT_MS = 10_000;
const REPLAY_BATCH = 500;
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** 客户端读得太慢时断开,而不是在内存里无限堆积。 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface WsDeps {
    repos: Repositories;
    bus: EventBus;
    logger: Logger;
    /** voice-state 帧的限流;不给时每个用户每秒 5 个(ADR 0021 第 6 节)。 */
    voiceLimiter?: WindowLimiter;
}

/**
 * 浏览器上报的 listening / speaking / idle 转成 assistant-state 事件,写入事件表并推给本人所有在线的端
 * (ADR 0021 第 6 节)。sessionId 不属于本人时按 null 处理。
 */
export function publishVoiceState(deps: Pick<WsDeps, 'repos' | 'bus'>, ownerId: string, report: VoiceStateReport) {
    const sessionId = report.sessionId && deps.repos.sessions.get(ownerId, report.sessionId) ? report.sessionId : null;
    const locale = deps.repos.settings.get(ownerId).locale;
    const envelope = deps.repos.events.append(ownerId, {
        sessionId,
        runId: null,
        event: { type: 'assistant-state', state: report.state, label: assistantLabel(report.state, locale) },
    });
    deps.bus.publish(ownerId, envelope);
}

type UpgradeAuth = { ok: true; ownerId: string } | { ok: false; status: 401 | 403 };

function cookieValue(header: string | undefined, name: string): string | null {
    for (const part of (header ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

/**
 * WebSocket 握手鉴权:Bearer 个人访问令牌,或会话 Cookie。
 * Cookie 会被浏览器自动带上,所以 Cookie 鉴权还要求 Origin 与 Host 一致,防止跨站 WebSocket 劫持。
 */
export function authenticateUpgrade(req: IncomingMessage, repos: Repositories): UpgradeAuth {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
        const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
        const record = token?.startsWith(PAT_PREFIX) ? repos.accessTokens.findUsable(sha256(token)) : null;
        return record ? { ok: true, ownerId: record.ownerId } : { ok: false, status: 401 };
    }
    const cookie = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const session = cookie ? repos.authSessions.getValid(sha256(cookie)) : null;
    if (!session) return { ok: false, status: 401 };
    const origin = req.headers.origin;
    const originHost = (() => {
        try {
            return origin ? new URL(origin).host : null;
        } catch {
            return null;
        }
    })();
    if (!originHost || !req.headers.host || !safeEqual(originHost, req.headers.host)) {
        return { ok: false, status: 403 };
    }
    return { ok: true, ownerId: session.ownerId };
}

function reject(socket: Duplex, status: 401 | 403 | 404): void {
    const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status];
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * 在 HTTP 服务器上挂载 /api/v1/ws(计划 6.1、ADR 0004 第 5 节)。
 * ws 库在第一次握手时才加载,不连接 WebSocket 的部署不占这部分内存。
 */
export function attachWebSocket(server: Server, input: WsDeps): { close(): void } {
    let wss: WebSocketServer | null = null;
    const deps: WsDeps = {
        ...input,
        voiceLimiter: input.voiceLimiter ?? new WindowLimiter(MAX_VOICE_STATE_FRAMES_PER_SECOND, 1000),
    };

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path !== WS_PATH) return reject(socket, 404);
        const auth = authenticateUpgrade(req, deps.repos);
        if (!auth.ok) return reject(socket, auth.status);
        void import('ws').then(({ WebSocketServer }) => {
            wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
            wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, auth.ownerId, deps));
        });
    });

    return {
        close() {
            for (const client of wss?.clients ?? []) client.terminate();
            wss?.close();
        },
    };
}

function handleConnection(ws: WebSocket, ownerId: string, deps: WsDeps): void {
    let frameId = 0;
    let last = 0;
    let live = false;
    let helloDone = false;
    let alive = true;
    const pending: EventEnvelope[] = [];
    let unsubscribe: (() => void) | null = null;
    /** 本连接最后上报的语音状态;断开时如果还在听 / 朗读,替它发一次 idle。 */
    let voice: VoiceStateReport | null = null;

    const send = (frame: ServerFrame) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.close(1013, 'client too slow');
            return;
        }
        ws.send(JSON.stringify(frame));
    };
    const nextId = () => `s${++frameId}`;
    const sendEvent = (envelope: EventEnvelope) => {
        if (envelope.seq <= last) return;
        last = envelope.seq;
        send({ v: PROTOCOL_VERSION, type: 'event', id: nextId(), seq: envelope.seq, payload: envelope });
    };
    const fail = (code: number, detail: string) => {
        send({
            v: PROTOCOL_VERSION,
            type: 'error',
            id: nextId(),
            payload: {
                type: 'about:blank',
                title: 'Bad Request',
                status: 400,
                code: 'validation_failed',
                detail,
                requestId: 'ws',
            },
        });
        ws.close(code, detail.slice(0, 120));
    };

    const helloTimer = setTimeout(() => {
        if (!helloDone) ws.close(4408, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    const pingTimer = setInterval(() => {
        if (!alive) {
            ws.terminate();
            return;
        }
        alive = false;
        ws.ping();
    }, WS_PING_INTERVAL_MS);
    ws.on('pong', () => {
        alive = true;
    });

    ws.on('message', (data, isBinary) => {
        let parsed: unknown;
        try {
            parsed = isBinary ? undefined : JSON.parse(String(data));
        } catch {
            parsed = undefined;
        }
        const result = ClientFrame.safeParse(parsed);
        if (!result.success) return fail(4400, 'invalid frame');
        const frame = result.data;
        if (frame.type === 'ping') {
            send({ v: PROTOCOL_VERSION, type: 'pong', id: nextId(), payload: {} });
            return;
        }
        if (frame.type === 'voice-state') {
            if (!helloDone) return fail(4400, 'hello first');
            // 超过每秒上限的帧直接丢弃,不报错
            if (deps.voiceLimiter && deps.voiceLimiter.take(ownerId) > 0) return;
            voice = frame.payload;
            publishVoiceState(deps, ownerId, frame.payload);
            return;
        }
        if (helloDone) return fail(4400, 'duplicate hello');
        helloDone = true;
        clearTimeout(helloTimer);
        if (frame.payload.protocolVersion !== PROTOCOL_VERSION) {
            return fail(4406, `unsupported protocol version ${frame.payload.protocolVersion}`);
        }

        // 先订阅并缓存,再补发,最后切到实时推送,保证不重不漏
        unsubscribe = deps.bus.subscribe(ownerId, (envelope) => {
            if (live) sendEvent(envelope);
            else pending.push(envelope);
        });
        const lastSeq = frame.payload.lastSeq;
        last = lastSeq ?? deps.repos.events.latestSeq(ownerId);
        const oldest = deps.repos.events.oldestSeq(ownerId);
        send({
            v: PROTOCOL_VERSION,
            type: 'welcome',
            id: nextId(),
            payload: {
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
                replayComplete: lastSeq === undefined || oldest === null || lastSeq >= oldest - 1,
            },
        });
        if (lastSeq !== undefined) {
            for (;;) {
                const batch = deps.repos.events.listAfter(ownerId, last, REPLAY_BATCH);
                batch.forEach(sendEvent);
                if (batch.length < REPLAY_BATCH) break;
            }
        }
        pending.splice(0).forEach(sendEvent);
        live = true;
    });

    ws.on('close', () => {
        clearTimeout(helloTimer);
        clearInterval(pingTimer);
        unsubscribe?.();
        if (voice && voice.state !== 'idle') {
            try {
                publishVoiceState(deps, ownerId, { state: 'idle', sessionId: voice.sessionId });
            } catch (error) {
                deps.logger.debug({ err: (error as Error).message }, 'voice idle on close failed');
            }
        }
    });
    ws.on('error', (error) => deps.logger.debug({ err: error.message }, 'websocket error'));
}

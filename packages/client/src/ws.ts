// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ClientFrame, EventEnvelope, ProblemDetails, ServerFrame, VoiceStateReport } from '@fatcat-ai/shared';

/** 与 shared 的 PROTOCOL_VERSION 一致(这里不在运行时加载 shared)。 */
export const CLIENT_PROTOCOL_VERSION = 1;

/** 4406:协议版本不支持,重连也没用。 */
const FATAL_CLOSE_CODES = new Set([4406]);

/** 最小的 WebSocket 构造器形状;Node ≥ 22 的全局 WebSocket 支持第二个参数里的 headers。 */
export type WebSocketLike = {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: { code: number; reason: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
};
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface ConnectEventsOptions {
    onEvent: (envelope: EventEnvelope) => void;
    /** 每次握手完成后调用;replayComplete 为 false 表示补发窗口已过,应改读消息列表。 */
    onWelcome?: (info: { serverVersion: string; replayComplete: boolean; reconnect: boolean }) => void;
    /** 服务器发来的 error 帧,或连接关闭(code / reason)。 */
    onError?: (error: { problem?: ProblemDetails; code?: number; reason?: string }) => void;
    /**
     * 已收到的最大 seq;给出时服务器先补发其后的事件。不给时只推送握手之后的实时事件,
     * 在收到第一个事件之前断线重连可能漏掉这段时间的事件。
     */
    lastSeq?: number;
    /** 断线自动重连,默认 true。 */
    reconnect?: boolean;
    backoffMs?: (attempt: number) => number;
}

export interface EventConnection {
    /** 已收到的最大 seq(重连时作为 lastSeq)。 */
    readonly lastSeq: number | undefined;
    /**
     * 上报本端正在收音 / 朗读 / 已结束(ADR 0021 第 6 节)。握手完成前只记下最后一次,握手后发出;
     * 重连后如果还在听或朗读,会再发一次。
     */
    reportVoiceState(report: VoiceStateReport): void;
    close(): void;
}

const defaultBackoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 15_000);

export function connectEvents(
    wsUrl: string,
    authHeaders: Record<string, string>,
    factory: WebSocketFactory,
    options: ConnectEventsOptions,
): EventConnection {
    let lastSeq = options.lastSeq;
    let closed = false;
    let attempt = 0;
    let connections = 0;
    let socket: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frameId = 0;
    let ready: WebSocketLike | null = null;
    let voice: VoiceStateReport | null = null;
    const backoff = options.backoffMs ?? defaultBackoff;

    const send = (ws: WebSocketLike, frame: ClientFrame) => ws.send(JSON.stringify(frame));

    const sendVoice = (ws: WebSocketLike, report: VoiceStateReport) =>
        send(ws, { v: CLIENT_PROTOCOL_VERSION, type: 'voice-state', id: `c${++frameId}`, payload: report });

    const open = () => {
        const ws = factory(wsUrl, authHeaders);
        const reconnect = connections > 0;
        connections += 1;
        socket = ws;
        ws.onopen = () => {
            send(ws, {
                v: CLIENT_PROTOCOL_VERSION,
                type: 'hello',
                id: `c${++frameId}`,
                payload: {
                    protocolVersion: CLIENT_PROTOCOL_VERSION,
                    ...(lastSeq !== undefined ? { lastSeq } : {}),
                },
            });
        };
        ws.onmessage = (ev) => {
            let frame: ServerFrame;
            try {
                frame = JSON.parse(String(ev.data)) as ServerFrame;
            } catch {
                return;
            }
            if (frame.type === 'welcome') {
                attempt = 0;
                ready = ws;
                if (voice && voice.state !== 'idle') sendVoice(ws, voice);
                options.onWelcome?.({
                    serverVersion: frame.payload.serverVersion,
                    replayComplete: frame.payload.replayComplete,
                    reconnect,
                });
            } else if (frame.type === 'event') {
                if (lastSeq !== undefined && frame.seq <= lastSeq) return;
                lastSeq = frame.seq;
                options.onEvent(frame.payload);
            } else if (frame.type === 'error') {
                options.onError?.({ problem: frame.payload });
            }
            // 未知帧类型忽略(ADR 0004)
        };
        ws.onerror = () => undefined;
        ws.onclose = (ev) => {
            if (socket === ws) socket = null;
            if (ready === ws) ready = null;
            if (closed) return;
            options.onError?.({ code: ev.code, reason: ev.reason });
            if (options.reconnect === false || FATAL_CLOSE_CODES.has(ev.code)) {
                closed = true;
                return;
            }
            attempt += 1;
            timer = setTimeout(open, backoff(attempt));
        };
    };

    open();
    return {
        get lastSeq() {
            return lastSeq;
        },
        reportVoiceState(report) {
            voice = report;
            if (ready && ready.readyState === 1) sendVoice(ready, report);
        },
        close() {
            closed = true;
            if (timer) clearTimeout(timer);
            socket?.close(1000, 'client closed');
            socket = null;
        },
    };
}

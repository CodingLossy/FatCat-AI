// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { connectEvents, type WebSocketLike } from './ws.js';

function fakeSocket() {
    const sent: { type: string; payload: unknown }[] = [];
    const ws: WebSocketLike & { open(): void; welcome(): void } = {
        readyState: 0,
        send: (data) => sent.push(JSON.parse(data) as { type: string; payload: unknown }),
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        open() {
            (ws as { readyState: number }).readyState = 1;
            ws.onopen?.({});
        },
        welcome() {
            ws.onmessage?.({
                data: JSON.stringify({
                    v: 1,
                    type: 'welcome',
                    id: 's1',
                    payload: { protocolVersion: 1, serverVersion: 't', replayComplete: true },
                }),
            });
        },
    };
    return { ws, sent };
}

describe('connectEvents.reportVoiceState', () => {
    it('握手前只记下最后一次,握手后发出;之后直接发', () => {
        const { ws, sent } = fakeSocket();
        const conn = connectEvents('ws://h/api/v1/ws', {}, () => ws, { onEvent: () => undefined });
        ws.open();
        conn.reportVoiceState({ state: 'listening', sessionId: null });
        expect(sent.map((f) => f.type)).toEqual(['hello']);
        ws.welcome();
        expect(sent.at(-1)).toMatchObject({ type: 'voice-state', payload: { state: 'listening', sessionId: null } });
        conn.reportVoiceState({ state: 'idle', sessionId: 's' });
        expect(sent.at(-1)).toMatchObject({ type: 'voice-state', payload: { state: 'idle', sessionId: 's' } });
        conn.close();
    });
});

describe('connectEvents 客户端调用(ADR 0046 第 14 节)', () => {
    it('给了 capabilities 才在握手后声明;client-call 帧交给 onClientCall;不给时什么都不发', () => {
        const calls: unknown[] = [];
        const withCaps = fakeSocket();
        connectEvents('ws://h/api/v1/ws', {}, () => withCaps.ws, {
            onEvent: () => undefined,
            capabilities: { browser: true },
            onClientCall: (call) => calls.push(call),
        });
        withCaps.ws.open();
        withCaps.ws.welcome();
        expect(withCaps.sent.map((f) => f.type)).toEqual(['hello', 'client-capabilities']);
        expect(withCaps.sent[1]?.payload).toEqual({ browser: true });
        const call = { callId: 'cc_abcdefghijklmnop', tool: 'browser.screenshot', url: 'https://a.b/', expiresAt: 'x' };
        withCaps.ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'client-call', id: 's2', payload: call }) });
        expect(calls).toEqual([call]);

        const plain = fakeSocket();
        connectEvents('ws://h/api/v1/ws', {}, () => plain.ws, { onEvent: () => undefined });
        plain.ws.open();
        plain.ws.welcome();
        expect(plain.sent.map((f) => f.type)).toEqual(['hello']);
    });
});

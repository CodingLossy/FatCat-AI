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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { ClientCall, ClientCallResult, ClientFrame, ServerFrame } from './index.js';

describe('客户端执行的调用', () => {
    it('client-capabilities 与 client-call 帧可以解析', () => {
        expect(
            ClientFrame.parse({ v: 1, type: 'client-capabilities', id: 'c1', payload: { browser: true } }).type,
        ).toBe('client-capabilities');
        const call = {
            callId: 'cc_abcdefghijklmnop',
            tool: 'browser.screenshot',
            url: 'https://example.com/',
            expiresAt: '2026-11-20T03:00:00.000Z',
        };
        expect(ClientCall.safeParse(call).success).toBe(true);
        expect(ServerFrame.parse({ v: 1, type: 'client-call', id: 's1', payload: call }).type).toBe('client-call');
    });

    it('callId 必须是服务器生成的形态;结果的形状与大小受限', () => {
        const base = { tool: 'browser.screenshot', url: 'https://a.b/', expiresAt: '2026-11-20T03:00:00.000Z' };
        expect(ClientCall.safeParse({ ...base, callId: 'call-1' }).success).toBe(false);
        expect(ClientCallResult.safeParse({ ok: false, code: 'blocked' }).success).toBe(true);
        expect(ClientCallResult.safeParse({ ok: false, code: 'nope' }).success).toBe(false);
        const image = { ok: true, mimeType: 'image/png', width: 10, height: 10 };
        expect(ClientCallResult.safeParse({ ...image, data: 'AAAA' }).success).toBe(true);
        expect(ClientCallResult.safeParse({ ...image, data: 'A'.repeat(3_000_000) }).success).toBe(false);
        expect(ClientCallResult.safeParse({ ...image, mimeType: 'image/svg+xml', data: 'AAAA' }).success).toBe(false);
    });

    it('system.open:目标是网址或文件,「已打开」是第三种结果;旧客户端不声明 open 也能解析', () => {
        const call = {
            callId: 'cc_abcdefghijklmnop',
            tool: 'system.open',
            target: { kind: 'file', path: '/home/me/notes/a.pdf' },
            expiresAt: '2026-11-20T03:00:00.000Z',
        };
        expect(ClientCall.safeParse(call).success).toBe(true);
        expect(ClientCall.safeParse({ ...call, target: { kind: 'app', path: 'x' } }).success).toBe(false);
        expect(ClientCall.safeParse({ ...call, target: { kind: 'url' } }).success).toBe(false);
        expect(ClientCallResult.safeParse({ ok: true, opened: true }).success).toBe(true);
        expect(ClientCallResult.safeParse({ ok: true }).success).toBe(false);
        expect(
            ClientFrame.parse({ v: 1, type: 'client-capabilities', id: 'c2', payload: { browser: false } }).type,
        ).toBe('client-capabilities');
    });
});

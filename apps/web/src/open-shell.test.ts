// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { openWithShell } from './browser-panel.js';

describe('桌面壳里的客户端调用', () => {
    it('system.open:原样把目标交给壳的 system_open;壳拒绝时回 blocked,其他失败回 failed,不抛出', async () => {
        const calls: [string, unknown][] = [];
        const target = { kind: 'url', url: 'https://example.com/' } as const;
        const ok = await openWithShell(async (command, args) => {
            calls.push([command, args]);
            return undefined;
        }, target);
        expect(ok).toEqual({ ok: true, opened: true });
        expect(calls).toEqual([['system_open', { target }]]);
        expect(await openWithShell(() => Promise.reject('blocked'), target)).toEqual({ ok: false, code: 'blocked' });
        expect(await openWithShell(() => Promise.reject('not_found'), target)).toEqual({ ok: false, code: 'blocked' });
        expect(await openWithShell(() => Promise.reject(new Error('boom')), target)).toEqual({
            ok: false,
            code: 'failed',
        });
    });
});

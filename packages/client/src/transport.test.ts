// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { FatCatApiError } from './errors.js';
import { Transport } from './transport.js';

const problem = (status: number) =>
    new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, code: 'unauthorized', requestId: 'r' }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });

describe('Transport 令牌刷新', () => {
    it('401 时刷新一次并用新令牌重试;并发的 401 共用一次刷新', async () => {
        let token = 'old';
        let refreshes = 0;
        const seen: string[] = [];
        const t = new Transport({
            baseUrl: 'http://x.test',
            token: () => token,
            refreshToken: async (stale) => {
                expect(stale).toBe('old');
                refreshes += 1;
                await Promise.resolve();
                token = 'new';
                return true;
            },
            fetch: (async (_url: string, init: RequestInit) => {
                const auth = (init.headers as Record<string, string>).authorization ?? '';
                seen.push(auth);
                return auth === 'Bearer new' ? Response.json({ ok: true }) : problem(401);
            }) as unknown as typeof fetch,
        });
        const [a, b] = await Promise.all([t.json('/a'), t.json('/b')]);
        expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
        expect(refreshes).toBe(1);
        expect(seen.filter((h) => h === 'Bearer old')).toHaveLength(2);
    });

    it('刷新失败或重试后仍是 401 时抛出原错误,不会无限重试', async () => {
        let calls = 0;
        const fetchAlways401 = (async () => {
            calls += 1;
            return problem(401);
        }) as unknown as typeof fetch;
        const failing = new Transport({
            baseUrl: 'http://x.test',
            token: 'tok',
            refreshToken: () => Promise.resolve(false),
            fetch: fetchAlways401,
        });
        await expect(failing.json('/a')).rejects.toBeInstanceOf(FatCatApiError);
        expect(calls).toBe(1);

        calls = 0;
        const stubborn = new Transport({
            baseUrl: 'http://x.test',
            token: 'tok',
            refreshToken: () => Promise.resolve(true),
            fetch: fetchAlways401,
        });
        await expect(stubborn.json('/a')).rejects.toBeInstanceOf(FatCatApiError);
        expect(calls).toBe(2);
    });
});

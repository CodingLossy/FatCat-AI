// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Handler = (event: unknown) => void;

/** 在带假 self / caches 的沙箱里加载 public/sw.js,返回 fetch 处理器与缓存内容。 */
function load() {
    const handlers: Record<string, Handler> = {};
    const store = new Map<string, unknown>();
    const caches = {
        open: async () => ({
            put: async (req: { url: string }, res: unknown) => void store.set(req.url, res),
            addAll: async () => undefined,
        }),
        match: async (req: { url: string } | string) => store.get(typeof req === 'string' ? req : req.url),
        keys: async () => [],
        delete: async () => true,
    };
    const self = {
        location: { origin: 'https://app.test' },
        addEventListener: (name: string, fn: Handler) => void (handlers[name] = fn),
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined },
    };
    const sandbox = { self, caches, URL, Request, Response, fetch: async () => new Response('x') };
    vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox);
    const run = async (path: string, init: { method?: string; mode?: string; cacheControl?: string } = {}) => {
        let responded: Promise<unknown> | null = null;
        const request = { url: `https://app.test${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' };
        sandbox.fetch = async () => new Response('body', { headers: { 'Cache-Control': init.cacheControl ?? '' } });
        handlers['fetch']?.({ request, respondWith: (p: Promise<unknown>) => (responded = p) });
        if (responded) await responded;
        await new Promise((r) => setTimeout(r, 0));
        return { intercepted: responded !== null };
    };
    return { run, store };
}

describe('service worker', () => {
    it('不拦截也不缓存 /api 与非 GET 请求', async () => {
        const { run, store } = load();
        expect((await run('/api/v1/sessions')).intercepted).toBe(false);
        expect((await run('/assets/a.js', { method: 'POST' })).intercepted).toBe(false);
        expect(store.size).toBe(0);
    });

    it('缓存 /assets 静态资源,但跳过声明 no-store 的响应', async () => {
        const { run, store } = load();
        expect((await run('/assets/a.js')).intercepted).toBe(true);
        expect(store.has('https://app.test/assets/a.js')).toBe(true);
        await run('/assets/secret.js', { cacheControl: 'no-store' });
        expect(store.has('https://app.test/assets/secret.js')).toBe(false);
    });
});

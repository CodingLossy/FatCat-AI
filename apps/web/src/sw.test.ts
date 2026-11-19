// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Handler = (event: unknown) => void;

const ORIGIN = 'https://app.test';

interface RunInit {
    method?: string;
    mode?: string;
    cacheControl?: string;
    contentType?: string;
    body?: string;
    offline?: boolean;
}

/** 在带假 self / caches 的沙箱里加载 public/sw.js,返回 fetch 处理器与缓存内容。 */
function load() {
    const handlers: Record<string, Handler> = {};
    const store = new Map<string, Response>();
    const href = (req: { url: string } | string) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
    const caches = {
        open: async () => ({
            put: async (req: { url: string }, res: Response) => void store.set(href(req), res),
            addAll: async () => undefined,
        }),
        match: async (req: { url: string } | string) => store.get(href(req)),
        keys: async () => [],
        delete: async () => true,
    };
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (name: string, fn: Handler) => void (handlers[name] = fn),
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined },
    };
    // 真实 service worker 里 new Request('/') 以自身地址为基准;Node 里需要补上。
    class SwRequest extends Request {
        constructor(input: string | Request, init?: RequestInit) {
            super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
        }
    }
    const sandbox = { self, caches, URL, Request: SwRequest, Response, fetch: async () => new Response('x') };
    vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox);
    const run = async (path: string, init: RunInit = {}) => {
        let responded: Promise<Response> | null = null;
        const request = { url: `${ORIGIN}${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' };
        sandbox.fetch = async () => {
            if (init.offline) throw new TypeError('offline');
            return new Response(init.body ?? 'body', {
                headers: { 'Cache-Control': init.cacheControl ?? '', 'Content-Type': init.contentType ?? '' },
            });
        };
        handlers['fetch']?.({ request, respondWith: (p: Promise<Response>) => (responded = p) });
        const response = responded ? await (responded as Promise<Response>) : null;
        await new Promise((r) => setTimeout(r, 0));
        return { intercepted: responded !== null, text: response ? await response.clone().text() : null };
    };
    const cachedText = async (path: string) => (await store.get(`${ORIGIN}${path}`)?.clone().text()) ?? null;
    return { run, store, cachedText };
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
        expect(store.has(`${ORIGIN}/assets/a.js`)).toBe(true);
        await run('/assets/secret.js', { cacheControl: 'no-store' });
        expect(store.has(`${ORIGIN}/assets/secret.js`)).toBe(false);
    });

    it('只有 HTML 导航才更新应用壳:直接打开 /offline.html 或图标不会覆盖 `/`', async () => {
        const { run, cachedText } = load();
        const html = { mode: 'navigate', contentType: 'text/html' };
        await run('/sessions/abc', { ...html, body: '<index>' });
        expect(await cachedText('/')).toBe('<index>');
        await run('/offline.html', { ...html, body: '<offline>' });
        await run('/icons/icon-192.png', { mode: 'navigate', contentType: 'image/png', body: 'png' });
        expect(await cachedText('/')).toBe('<index>');
        // 离线时回退到缓存的应用壳
        expect((await run('/anything', { ...html, offline: true })).text).toBe('<index>');
    });

    it('manifest 与图标网络优先:在线拿最新内容,离线用上次缓存', async () => {
        const { run, cachedText } = load();
        await run('/manifest.webmanifest', { body: 'v1' });
        expect((await run('/manifest.webmanifest', { body: 'v2' })).text).toBe('v2');
        expect(await cachedText('/manifest.webmanifest')).toBe('v2');
        expect((await run('/manifest.webmanifest', { offline: true })).text).toBe('v2');
    });
});

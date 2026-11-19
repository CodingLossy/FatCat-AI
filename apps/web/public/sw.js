// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/* global self, caches */

// Service worker(ADR 0045 第 4 节):只缓存应用壳和静态资源,**绝不缓存 API 响应**,
// 这样离线时能打开界面,但对话、邮件等内容不会留在缓存里。
// - 导航请求:网络优先;网络失败时用缓存的 `/`(前端路由接管),再不行用 /offline.html。
// - /assets/*(文件名带内容哈希)与图标 / manifest:缓存优先。
// - /api/*、/healthz、非 GET、跨域、服务器声明 no-store 的响应:一律不碰、不缓存。
const CACHE = 'fatcat-shell-v1';
const PRECACHE = ['/', '/offline.html', '/manifest.webmanifest'];

function cacheable(url, request) {
    if (request.method !== 'GET') return false;
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return false;
    return true;
}

function isStaticAsset(url) {
    return (
        url.pathname.startsWith('/assets/') ||
        url.pathname.startsWith('/icons/') ||
        url.pathname === '/manifest.webmanifest'
    );
}

async function put(request, response) {
    // 只缓存成功且没有声明 no-store 的响应。
    if (!response || !response.ok) return;
    const control = response.headers.get('Cache-Control') || '';
    if (/no-store/i.test(control)) return;
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' }))))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (!cacheable(url, request)) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // 前端路由的任何页面都是同一个 index.html,统一缓存在 `/` 下。
                    void put(new Request('/'), response);
                    return response;
                })
                .catch(
                    async () => (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error(),
                ),
        );
        return;
    }

    if (isStaticAsset(url)) {
        event.respondWith(
            caches.match(request).then(
                (hit) =>
                    hit ||
                    fetch(request).then((response) => {
                        void put(request, response);
                        return response;
                    }),
            ),
        );
    }
});

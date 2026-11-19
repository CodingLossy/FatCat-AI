// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/* global self, caches */

// Service worker(ADR 0045 第 4 节):只缓存应用壳和静态资源,**绝不缓存 API 响应**,
// 这样离线时能打开界面,但对话、邮件等内容不会留在缓存里。
// - 导航请求:网络优先;网络失败时用缓存的 `/`(前端路由接管),再不行用 /offline.html。
// - /assets/*(文件名带内容哈希):缓存优先。
// - 图标、manifest:网络优先,失败再用缓存(换图标或改 manifest 后用户能拿到新的)。
// - /api/*、/healthz、非 GET、跨域、服务器声明 no-store 的响应:一律不碰、不缓存。
// 缓存名带构建标识:`pnpm build` 时 vite.config.ts 把下面的构建标识占位符换成构建产物的哈希。每次发布缓存名都变,
// activate 时旧名字的缓存(含旧的 /assets/* 文件)整体删除。开发和测试里占位符原样保留,不影响行为。
const CACHE = 'fatcat-shell-' + '__BUILD_ID__';
const PRECACHE = ['/', '/offline.html', '/manifest.webmanifest'];

function cacheable(url, request) {
    if (request.method !== 'GET') return false;
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return false;
    return true;
}

/** 带内容哈希的构建产物:内容不会变,缓存优先。 */
function isHashedAsset(url) {
    return url.pathname.startsWith('/assets/');
}

/** 文件名不带哈希、但内容可能随发布变化的静态文件:网络优先。 */
function isMutableStatic(url) {
    return url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
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
                    // 直接在地址栏打开 /offline.html、图标、manifest 等也是导航请求,它们不是应用壳,不能覆盖 `/`。
                    const type = response.headers.get('Content-Type') || '';
                    if (/text\/html/i.test(type) && url.pathname !== '/offline.html') {
                        void put(new Request('/'), response);
                    }
                    return response;
                })
                .catch(
                    async () => (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error(),
                ),
        );
        return;
    }

    if (isHashedAsset(url)) {
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
        return;
    }

    if (isMutableStatic(url)) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    void put(request, response);
                    return response;
                })
                .catch(async () => (await caches.match(request)) || Response.error()),
        );
    }
});

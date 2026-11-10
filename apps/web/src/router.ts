// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 极简路由(ADR 0009 第 2 节):History API + popstate;服务器对未知路径回退到 index.html。
import { useEffect, useState } from 'react';

export type Route =
    | { name: 'home' }
    | { name: 'session'; id: string }
    | { name: 'settings' }
    | { name: 'memory' }
    | { name: 'audit' }
    | { name: 'items' }
    | { name: 'mail' };

export function parseRoute(path: string): Route {
    const session = /^\/s\/([0-9A-Za-z]+)\/?$/.exec(path);
    if (session) return { name: 'session', id: session[1]! };
    if (path === '/settings') return { name: 'settings' };
    if (path === '/memory') return { name: 'memory' };
    if (path === '/audit') return { name: 'audit' };
    if (path === '/items') return { name: 'items' };
    if (path === '/mail') return { name: 'mail' };
    return { name: 'home' };
}

export function routePath(route: Route): string {
    return route.name === 'session' ? `/s/${route.id}` : route.name === 'home' ? '/' : `/${route.name}`;
}

const listeners = new Set<() => void>();

export function navigate(route: Route, replace = false): void {
    const path = routePath(route);
    if (path !== window.location.pathname) {
        if (replace) window.history.replaceState(null, '', path);
        else window.history.pushState(null, '', path);
    }
    for (const l of listeners) l();
}

export function useRoute(): Route {
    const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
    useEffect(() => {
        const update = () => setRoute(parseRoute(window.location.pathname));
        listeners.add(update);
        window.addEventListener('popstate', update);
        return () => {
            listeners.delete(update);
            window.removeEventListener('popstate', update);
        };
    }, []);
    return route;
}

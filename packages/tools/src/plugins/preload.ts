// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件进程的运行时预加载(ADR 0040 第 3.4 节):在插件代码之前运行(`node --import`),收紧能联网、能起子进程的入口。
// 这是多层防护的第一层,不是硬墙:Node 的权限模型管文件、子进程、worker、addon,不管网络。
// 本文件只依赖 node:module,不能引入别的模块(权限模型下只允许读本文件与插件目录)。
import { registerHooks } from 'node:module';

/** 被拒绝的内置模块(同时拒绝带 `node:` 前缀与不带前缀的写法,以及它们的子路径如 `dns/promises`)。 */
export const DENIED_BUILTINS = [
    'net',
    'tls',
    'http',
    'https',
    'http2',
    'dgram',
    'dns',
    'child_process',
    'worker_threads',
    'cluster',
    'inspector',
    'vm',
    'repl',
    'sqlite',
    '_http_agent',
    '_http_client',
    '_http_common',
    '_http_incoming',
    '_http_outgoing',
    '_http_server',
    '_tls_common',
    '_tls_wrap',
] as const;

const denied = new Set<string>(DENIED_BUILTINS);

function isDenied(specifier: string): boolean {
    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    const root = bare.split('/')[0] ?? bare;
    return denied.has(root);
}

function deny(what: string): never {
    const error = new Error(`${what} is not available to FatCat-AI plugins`) as Error & { code: string };
    error.code = 'ERR_ACCESS_DENIED';
    throw error;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (isDenied(specifier)) deny(`The module "${specifier}"`);
        return nextResolve(specifier, context);
    },
});

const original = process.getBuiltinModule?.bind(process);
if (original) {
    Object.defineProperty(process, 'getBuiltinModule', {
        value: (id: string) => {
            if (typeof id === 'string' && isDenied(id)) deny(`The module "${id}"`);
            return original(id as 'fs');
        },
        writable: false,
        configurable: false,
    });
}

for (const name of ['binding', '_linkedBinding', 'dlopen'] as const) {
    Object.defineProperty(process, name, {
        value: () => deny(`process.${name}`),
        writable: false,
        configurable: false,
    });
}

for (const name of ['fetch', 'WebSocket', 'EventSource'] as const) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
}

export {};

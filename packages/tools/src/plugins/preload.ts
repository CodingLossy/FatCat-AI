// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件进程的运行时预加载(ADR 0040 第 3.4 节):在插件代码之前运行(`node --import`),收紧能联网、能起子进程的入口。
// 这是多层防护的第一层,不是硬墙:Node 的权限模型管文件、子进程、worker、addon,不管网络。
// 本文件只依赖 node:module,不能引入别的模块(权限模型下只允许读本文件与插件目录)。
import Module, { registerHooks } from 'node:module';
import net from 'node:net';

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
    // 能注册自己的模块钩子、绕过本文件的拒绝钩子(别名指向 node:http 等),或改 V8 标志、起 WASI
    'module',
    'wasi',
    'v8',
    'tty',
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
        const result = nextResolve(specifier, context);
        // 按「解析结果」再查一次:插件改写 Module._resolveFilename 把别名指向内置模块时,原始写法不在名单里
        const url = (result as { url?: unknown; format?: unknown } | undefined)?.url;
        if (
            typeof url === 'string' &&
            (url.startsWith('node:') || (result as { format?: unknown }).format === 'builtin')
        ) {
            if (isDenied(url)) deny(`The module "${url}"`);
        }
        return result;
    },
    load(url, context, nextLoad) {
        if (url.startsWith('node:') && isDenied(url)) deny(`The module "${url}"`);
        return nextLoad(url, context);
    },
});

// 把这几个 CommonJS 的解析与加载入口锁死,插件不能改写
for (const name of ['_resolveFilename', '_load', '_findPath'] as const) {
    const value = (Module as unknown as Record<string, unknown>)[name];
    if (value !== undefined) Object.defineProperty(Module, name, { value, writable: false, configurable: false });
}

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

// 没有 `node:module` 也能从 CommonJS 的 `module.constructor` 拿到 Module:把注册钩子的入口封死
for (const name of ['registerHooks', 'register'] as const) {
    Object.defineProperty(Module, name, {
        value: () => deny(`module.${name}`),
        writable: false,
        configurable: false,
    });
}

// 同一用户下插件能给主进程发信号(已知限制,见 ADR 0040 实现注记);至少挡住对父进程与进程组的误用
const originalKill = process.kill.bind(process);
Object.defineProperty(process, 'kill', {
    value: (pid: number, signal?: string | number) => {
        if (pid === process.ppid || pid <= 0) deny('Signalling the parent process or a process group');
        return originalKill(pid, signal);
    },
    writable: false,
    configurable: false,
});

// 「已经存在的对象」也能连网:插件的 stdin / stdout 是 net.Socket(管道),`process.stdin.constructor` 就是 net.Socket,
// 底层 handle(Pipe)有 connect / open / bind / listen。先创建好三条标准流(spawn 时的管道不走 connect),再把这些入口封死。
const lockedConnect = () => deny('Opening network connections');
const lock = (target: object | null | undefined, names: readonly string[]): void => {
    if (!target) return;
    for (const name of names) {
        if (typeof (target as Record<string, unknown>)[name] !== 'function') continue;
        Object.defineProperty(target, name, { value: lockedConnect, writable: false, configurable: false });
    }
};
lock(net.Socket.prototype, ['connect', '_connect']);
for (const stream of [process.stdin, process.stdout, process.stderr]) {
    const handle = (stream as unknown as { _handle?: object | null })._handle;
    lock(handle ? Object.getPrototypeOf(handle) : null, ['connect', 'connect6', 'open', 'bind', 'bind6', 'listen']);
}

for (const name of ['binding', '_linkedBinding', 'dlopen', '_kill', '_debugProcess'] as const) {
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

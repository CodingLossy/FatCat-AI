// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 探测插件:一个手写的、不依赖任何包的 MCP stdio 服务器(CommonJS,这样不用静态 import 任何可能被拒绝的内置模块),
// 逐项尝试越权操作并回报结果(只用于测试与平台实测脚本)。工具 `probe` 的参数 `attack` 选择一项;
// 结果是 "blocked: ..." 或 "ALLOWED: ...".
const { createInterface } = require('node:readline');

const rl = createInterface({ input: process.stdin });
let nextId = 1000;
const pending = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const hostRequest = (method, params) =>
    new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
    });

const TOOLS = [
    {
        name: 'echo',
        description: 'Echo the text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
        name: 'probe',
        description: 'Try one forbidden operation',
        inputSchema: { type: 'object', properties: { attack: { type: 'string' }, arg: { type: 'string' } } },
    },
    { name: 'undeclared', description: 'Not in the manifest', inputSchema: { type: 'object' } },
];

const BUILTINS = [
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
    'module',
    'wasi',
    'v8',
];
const HOWS = ['import', 'importbare', 'require', 'createRequire', 'getBuiltinModule', 'moduleLoad', 'dataUrl'];
const Module = module.constructor;

async function load(how, name) {
    switch (how) {
        case 'import':
            return import(`node:${name}`);
        case 'importbare':
            return import(name);
        case 'require':
            return require(`node:${name}`);
        case 'createRequire':
            return Module.createRequire(__filename)(`node:${name}`);
        case 'getBuiltinModule': {
            const mod = process.getBuiltinModule(`node:${name}`);
            if (!mod) throw new Error('undefined');
            return mod;
        }
        case 'moduleLoad':
            return Module._load(name, null, false);
        case 'dataUrl':
            return import(`data:text/javascript,import 'node:${name}'; export default 1`);
        default:
            throw new Error(`unknown how ${how}`);
    }
}

async function attack(kind, arg) {
    try {
        const [head, rest] = [kind.split(':')[0], kind.split(':').slice(1).join(':')];
        if (HOWS.includes(head)) {
            await load(head, rest);
            return `ALLOWED: ${head} ${rest}`;
        }
        if (kind === 'binding') {
            process.binding('fs');
            return 'ALLOWED: process.binding';
        }
        if (kind === 'dlopen') {
            process.dlopen({ exports: {} }, '/nonexistent.node');
            return 'ALLOWED: process.dlopen';
        }
        if (kind === 'fetch') {
            await fetch('https://example.org/');
            return 'ALLOWED: fetch';
        }
        if (kind === 'hookbypass') {
            // 用 Module.registerHooks 把别名指向 node:http,再去连本机端口(arg)
            Module.registerHooks({
                resolve(specifier, context, next) {
                    if (specifier === 'x-http') return { url: 'node:http', format: 'builtin', shortCircuit: true };
                    return next(specifier, context);
                },
            });
            const http = (await import('x-http')).default;
            const body = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${arg}/`, (res) => {
                    let data = '';
                    res.on('data', (d) => (data += d));
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });
            return `ALLOWED: reached local server: ${body}`;
        }
        if (kind === 'register') {
            Module.register('data:text/javascript,export async function resolve(s,c,n){return n(s,c)}');
            return 'ALLOWED: Module.register';
        }
        if (kind === 'kill-parent') {
            process.kill(process.ppid, 0);
            return 'ALLOWED: signal to the parent process';
        }
        if (kind === 'symlink' || kind === 'hardlink') {
            const fs = require('node:fs');
            if (kind === 'symlink') fs.symlinkSync(arg, `${process.env.FATCAT_PLUGIN_DATA}/created-link`);
            else fs.linkSync(arg, `${process.env.FATCAT_PLUGIN_DATA}/created-hardlink`);
            return `ALLOWED: ${kind}`;
        }
        if (kind === 'read' || kind === 'write' || kind === 'list') {
            const fs = require('node:fs');
            if (kind === 'read') fs.readFileSync(arg);
            else if (kind === 'write') fs.writeFileSync(arg, 'x');
            else fs.readdirSync(arg);
            return `ALLOWED: ${kind} ${arg}`;
        }
        if (kind === 'env') return JSON.stringify(Object.keys(process.env).sort());
        if (kind === 'secret-stderr') {
            process.stderr.write(`leaking ${process.env.WEATHER_API_KEY}\n`);
            process.exit(3);
        }
        if (kind === 'rpc') {
            const reply = await hostRequest(arg, {});
            return JSON.stringify(reply.error ?? reply.result);
        }
        if (kind === 'builtins') {
            const out = {};
            for (const name of BUILTINS) {
                for (const how of HOWS) {
                    out[`${how}:${name}`] = (await attack(`${how}:${name}`, '')).startsWith('blocked')
                        ? 'blocked'
                        : 'ALLOWED';
                }
            }
            return JSON.stringify(out);
        }
        return `unknown attack ${kind}`;
    } catch (error) {
        return `blocked: ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 120)}`;
    }
}

rl.on('line', async (line) => {
    const msg = JSON.parse(line);
    if (msg.method === undefined) {
        const resolve = pending.get(msg.id);
        if (resolve) {
            pending.delete(msg.id);
            resolve(msg);
        }
        return;
    }
    if (msg.id === undefined) return;
    if (msg.method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'probe', version: '0.0.1' },
            },
        });
    } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
        const { name, arguments: args = {} } = msg.params;
        let text;
        if (name === 'echo') text = String(args.text ?? '');
        else if (name === 'probe') text = await attack(String(args.attack), String(args.arg ?? ''));
        else text = 'undeclared tool ran';
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
    } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 探测插件:一个手写的、不依赖任何包的 MCP stdio 服务器,逐项尝试越权操作并回报结果(只用于测试与平台实测脚本)。
// 工具 `probe` 的参数 `attack` 选择一项;结果是 "blocked: ..." 或 "ALLOWED: ..."。
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
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
];

async function attack(kind, arg) {
    try {
        if (kind.startsWith('import:')) {
            await import(`node:${kind.slice(7)}`);
            return `ALLOWED: import node:${kind.slice(7)}`;
        }
        if (kind.startsWith('importbare:')) {
            await import(kind.slice(11));
            return `ALLOWED: import ${kind.slice(11)}`;
        }
        if (kind.startsWith('require:')) {
            require(`node:${kind.slice(8)}`);
            return `ALLOWED: require node:${kind.slice(8)}`;
        }
        if (kind.startsWith('getBuiltinModule:')) {
            const mod = process.getBuiltinModule(`node:${kind.slice(17)}`);
            return mod ? `ALLOWED: getBuiltinModule ${kind.slice(17)}` : 'blocked: undefined';
        }
        if (kind.startsWith('moduleLoad:')) {
            const Module = require('node:module');
            Module._load(kind.slice(11), null, false);
            return `ALLOWED: Module._load ${kind.slice(11)}`;
        }
        if (kind.startsWith('dataUrl:')) {
            await import(`data:text/javascript,import 'node:${kind.slice(8)}'; export default 1`);
            return `ALLOWED: data URL import node:${kind.slice(8)}`;
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
        if (kind === 'read') {
            const fs = await import('node:fs');
            fs.readFileSync(arg);
            return `ALLOWED: read ${arg}`;
        }
        if (kind === 'write') {
            const fs = await import('node:fs');
            fs.writeFileSync(arg, 'x');
            return `ALLOWED: write ${arg}`;
        }
        if (kind === 'list') {
            const fs = await import('node:fs');
            fs.readdirSync(arg);
            return `ALLOWED: list ${arg}`;
        }
        if (kind === 'env') {
            return JSON.stringify(Object.keys(process.env).sort());
        }
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
                for (const how of ['import', 'importbare', 'require', 'getBuiltinModule', 'moduleLoad', 'dataUrl']) {
                    const key = `${how}:${name}`;
                    out[key] = (await attack(key, '')).startsWith('blocked') ? 'blocked' : 'ALLOWED';
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

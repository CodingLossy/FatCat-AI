// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 测试用的假 MCP 服务器(stdio,按行分隔的 JSON-RPC 2.0),按规范手写,只实现客户端用到的方法。
// 用法:node fake-mcp-server.mjs [behaviour];behaviour 可为 normal、exit-on-init、no-reply。
import { createInterface } from 'node:readline';

const behaviour = process.argv[2] ?? 'normal';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
    {
        name: 'echo',
        description: 'Echo the text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
    { name: 'bad name!', description: 'A name with characters that must be replaced', inputSchema: { type: 'object' } },
    { name: 'env', description: 'Show selected environment variables', inputSchema: { type: 'object' } },
];

process.stderr.write('fake server starting\n');
createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
        if (behaviour === 'exit-on-init') process.exit(3);
        if (behaviour === 'no-reply') return;
        // 握手前先发一条通知和一行非 JSON 的日志,客户端应忽略
        send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } });
        process.stdout.write('not json\n');
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'fake', version: '1' },
            },
        });
    } else if (message.method === 'tools/list') {
        // 分两页返回,测试翻页
        const second = message.params?.cursor === 'page2';
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: second ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: 'page2' },
        });
        // 服务器发来的请求:客户端应回答「方法不存在」
        if (!second) send({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} });
    } else if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        if (name === 'echo') {
            send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    content: [
                        { type: 'text', text: `echo: ${args.text}` },
                        { type: 'image', data: 'x', mimeType: 'image/png' },
                    ],
                },
            });
        } else if (name === 'fail') {
            send({
                jsonrpc: '2.0',
                id: message.id,
                result: { content: [{ type: 'text', text: 'it broke' }], isError: true },
            });
        } else if (name === 'env') {
            send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                allowed: process.env.MCP_TEST_ALLOWED ?? null,
                                secret: process.env.MCP_TEST_SECRET ?? null,
                            }),
                        },
                    ],
                },
            });
        } else {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
        }
    } else if (message.id !== undefined && message.method === undefined) {
        // 客户端对服务器请求的回答:忽略
    }
});

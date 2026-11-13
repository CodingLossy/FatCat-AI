// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 假的 OpenAI 兼容模型端点(ADR 0018 第 5 节,内存压测用):只实现 POST /v1/chat/completions,
// 流式返回几段固定文字,非流式返回一条固定回复。不连外网,不记录请求正文。
// 用来让渠道负载真正跑完整的一轮对话(入队、runs.start、模型流式输出、写消息与会话、回复文本),而不是只走指令分支。
import { createServer } from 'node:http';

const REPLY_PARTS = ['收到', '，', '这是压测的固定回复。'];

/**
 * @returns {Promise<{ url: string, turns: () => number, close(): Promise<void> }>}
 *   url 以 /v1 结尾,直接作为模型配置档的 baseURL 使用;turns() 为收到的 chat/completions 请求数。
 */
export async function startFakeOpenAI() {
    let turns = 0;
    const open = new Set();

    const readJson = (req) =>
        new Promise((resolve) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                } catch {
                    resolve({});
                }
            });
        });

    const server = createServer(async (req, res) => {
        const path = new URL(req.url, 'http://x').pathname;
        if (req.method !== 'POST' || path !== '/v1/chat/completions') {
            res.writeHead(404).end();
            return;
        }
        const body = await readJson(req);
        turns += 1;
        const base = { id: `perf-${turns}`, object: 'chat.completion.chunk', model: body.model ?? 'perf-model' };

        if (body.stream !== true) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    ...base,
                    object: 'chat.completion',
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content: REPLY_PARTS.join('') },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            );
            return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const part of REPLY_PARTS) {
            res.write(
                `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`,
            );
        }
        res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
    });
    server.on('connection', (socket) => {
        open.add(socket);
        socket.on('close', () => open.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        url: `http://127.0.0.1:${server.address().port}/v1`,
        turns: () => turns,
        close() {
            for (const s of open) s.destroy();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

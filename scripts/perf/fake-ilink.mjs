// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 假的微信 iLink 服务器(ADR 0018 第 5 节,内存压测用):扫码立刻确认,getupdates 长轮询,sendmessage 只计数。
// 接口与字段只依据公开协议说明,与 packages/channels/src/ilink.ts 一致。不连外网,不记录令牌与消息正文。
import { createServer } from 'node:http';

/**
 * @param {{ longPollMs?: number }} [options] longPollMs:没有消息时挂起多久再返回空结果(协议说明约 35 秒)
 * @returns {Promise<{ url: string, push(text: string, fromUserId?: string): void, sent: () => number, close(): Promise<void> }>}
 */
export async function startFakeIlink({ longPollMs = 25_000 } = {}) {
    const queue = [];
    let nextId = 1;
    let sentCount = 0;
    let wake = null;
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
    const reply = (res, body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    const server = createServer(async (req, res) => {
        const path = new URL(req.url, 'http://x').pathname;
        if (path === '/ilink/bot/get_bot_qrcode') {
            await readJson(req);
            return reply(res, { ret: 0, qrcode: 'perf-qr', qrcode_img_content: 'https://example.test/perf-qr' });
        }
        if (path === '/ilink/bot/get_qrcode_status') {
            return reply(res, { status: 'confirmed', bot_token: 'perf-fake-token' });
        }
        if (path === '/ilink/bot/sendmessage') {
            await readJson(req);
            sentCount += 1;
            return reply(res, { ret: 0 });
        }
        if (path === '/ilink/bot/getupdates') {
            const body = await readJson(req);
            const answer = () => {
                const msgs = queue.splice(0, 10);
                reply(res, {
                    ret: 0,
                    msgs,
                    get_updates_buf: String(body.get_updates_buf || '0') + '.',
                    longpolling_timeout_ms: longPollMs,
                });
            };
            if (queue.length > 0) return answer();
            const timer = setTimeout(done, longPollMs);
            function done() {
                clearTimeout(timer);
                wake = null;
                answer();
            }
            wake = done;
            res.on('close', () => clearTimeout(timer));
            return;
        }
        res.writeHead(404).end();
    });
    server.on('connection', (socket) => {
        open.add(socket);
        socket.on('close', () => open.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        push(text, fromUserId = 'perf-owner') {
            const id = nextId++;
            queue.push({
                message_id: id,
                from_user_id: fromUserId,
                message_type: 1,
                create_time_ms: Date.now(),
                context_token: `ctx-${id}`,
                item_list: [{ type: 1, text_item: { text } }],
            });
            wake?.();
        },
        sent: () => sentCount,
        close() {
            for (const s of open) s.destroy();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

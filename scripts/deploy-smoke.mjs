// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 部署冒烟(M5c PR 4):经 Caddy 的 HTTP 测试变体检查生产 compose:/healthz、首页、设置码、WebSocket、SSE 流式。
// 不访问公网:模型端点是本脚本起的本地假服务,密钥是占位值。用法见 docs/deploy/docker.md 与 .github/workflows/ci.yml。
// node scripts/deploy-smoke.mjs <caddy 基址,如 http://127.0.0.1:8080> <设置码> [假模型在容器里的地址,默认 http://host.docker.internal:9999]
import { createServer } from 'node:http';

const [base, setupCode, fakeInContainer = 'http://host.docker.internal:9999'] = process.argv.slice(2);
if (!base || !setupCode) {
    console.error('usage: deploy-smoke.mjs <base-url> <setup-code> [fake-model-url-as-seen-from-the-container]');
    process.exit(2);
}
const api = `${base}/api/v1`;
const SECRET_NAME = 'SMOKE_KEY';
const STREAM_GAP_MS = 600;

function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) process.exitCode = 1;
    return ok;
}

// 假的 OpenAI 兼容端点:每个数据块间隔 STREAM_GAP_MS,用来判断代理有没有缓冲流
const fake = createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
        if (!req.url?.endsWith('/chat/completions')) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, extra = {}) =>
            `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...extra }] })}\n\n`;
        for (const word of ['one ', 'two ', 'three ']) {
            res.write(chunk({ content: word }));
            await new Promise((r) => setTimeout(r, STREAM_GAP_MS));
        }
        res.write(chunk({}, { finish_reason: 'stop' }));
        res.end('data: [DONE]\n\n');
    });
});
await new Promise((r) => fake.listen(9999, '0.0.0.0', r));

try {
    const health = await fetch(`${base}/healthz`);
    check('GET /healthz through the proxy', health.ok);
    const index = await fetch(`${base}/`);
    const html = await index.text();
    check('GET / serves the Web UI', index.ok && html.includes('<div id="root">'), `${index.status}`);
    check('app security headers pass through', index.headers.get('x-content-type-options') === 'nosniff');
    check('server header removed', index.headers.get('server') === null);

    const noCode = await fetch(`${api}/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    });
    check('setup without the code is refused behind the proxy', noCode.status === 403, `${noCode.status}`);
    const setup = await fetch(`${api}/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple', setupCode }),
    });
    check('setup with the code works', setup.ok, `${setup.status}`);
    const cookies = setup.headers.getSetCookie().map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith('aip_csrf='))?.split('=')[1] ?? '';
    const cookie = cookies.join('; ');
    const tokenRes = await fetch(`${api}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
        body: JSON.stringify({ name: 'deploy-smoke' }),
    });
    const { token } = await tokenRes.json();
    check('personal access token created', typeof token === 'string');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // WebSocket 经代理:握手、hello、ping/pong
    const wsUrl = `${base.replace(/^http/, 'ws')}/api/v1/ws`;
    const pong = await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
        const timer = setTimeout(() => resolve('timeout'), 8000);
        ws.addEventListener('open', () => ws.send(JSON.stringify({ v: 1, type: 'ping', id: 'c1', payload: {} })));
        ws.addEventListener('message', (e) => {
            if (JSON.parse(String(e.data)).type === 'pong') {
                clearTimeout(timer);
                ws.close();
                resolve('pong');
            }
        });
        ws.addEventListener('error', () => resolve('error'));
    });
    check('WebSocket ping/pong through the proxy', pong === 'pong', pong);

    // SSE 流式:假模型每 STREAM_GAP_MS 出一个数据块,事件应该一个一个到,而不是最后一起到
    const keyWrite = await fetch(`${api}/models`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
            label: 'smoke',
            kind: 'openai-compatible',
            baseURL: `${fakeInContainer}/v1`,
            apiKeyRef: `env:${SECRET_NAME}`,
            model: 'smoke',
            purpose: ['chat'],
        }),
    });
    check('model profile created', keyWrite.ok, `${keyWrite.status}`);
    const session = await (await fetch(`${api}/sessions`, { method: 'POST', headers: auth, body: '{}' })).json();
    const t0 = Date.now();
    const res = await fetch(`${api}/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'hello' }),
    });
    check('SSE response is event-stream', res.headers.get('content-type')?.startsWith('text/event-stream') === true);
    const arrivals = [];
    const decoder = new TextDecoder();
    let text = '';
    for await (const part of res.body) {
        text += decoder.decode(part, { stream: true });
        arrivals.push(Date.now() - t0);
    }
    const spread = arrivals.length ? arrivals.at(-1) - arrivals[0] : 0;
    check(
        'SSE arrives in several chunks, not buffered',
        arrivals.length >= 3 && spread >= STREAM_GAP_MS,
        `${arrivals.length} chunks over ${spread} ms`,
    );
    check('run finished', text.includes('run-finished'));
} finally {
    fake.close();
}

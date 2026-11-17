// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 对话峰值内存(M5c PR 5;对话峰值只测量报告):在 Docker 镜像里跑若干轮含工具调用与长回复的对话,
// 每 200 ms 读一次容器主进程的 VmRSS,报告峰值。模型是本脚本起的本地假端点(第一次请求返回 calc 工具调用,
// 拿到工具结果后流式返回约 40 KiB 的长回复),不连外网;密钥是占位值。
//
//   docker run -d --name fc -p 127.0.0.1:8787:8787 -e PEAK_KEY=x --add-host host.docker.internal:host-gateway fatcat-ai:prep
//   node scripts/perf/chat-peak.mjs http://127.0.0.1:8787 <设置码> fc
//   环境变量:SESSIONS(默认 10)、TURNS(每个会话的轮数,默认 3)、CAP_MIB(默认 400,只作对照:超过时打印提示,不影响退出码;ADR 0041)
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

const [base, setupCode, container, fakeInContainer = 'http://host.docker.internal:9998'] = process.argv.slice(2);
if (!base || !setupCode || !container) {
    console.error('usage: chat-peak.mjs <base-url> <setup-code> <container-name> [fake-model-url-in-container]');
    process.exit(2);
}
const SESSIONS = Number(process.env.SESSIONS ?? 10);
const TURNS = Number(process.env.TURNS ?? 3);
const CAP_MIB = Number(process.env.CAP_MIB ?? 400);
const api = `${base}/api/v1`;
const LONG = '这是压测用的长回复。'.repeat(20) + '\n';

let modelCalls = 0;
const fake = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        if (!req.url?.endsWith('/chat/completions')) return void res.writeHead(404).end();
        modelCalls += 1;
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            body = {};
        }
        const last = body.messages?.at(-1);
        const sse = (delta, extra = {}) =>
            `data: ${JSON.stringify({ id: 'peak', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...extra }] })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (last?.role !== 'tool') {
            const calc = (body.tools ?? []).find((t) => /calc/.test(t.function?.name ?? ''));
            if (calc) {
                res.write(
                    sse({
                        tool_calls: [
                            {
                                index: 0,
                                id: `call_${modelCalls}`,
                                type: 'function',
                                function: { name: calc.function.name, arguments: '{"expression":"sqrt(2)*21"}' },
                            },
                        ],
                    }),
                );
                res.write(sse({}, { finish_reason: 'tool_calls' }));
                return void res.end('data: [DONE]\n\n');
            }
        }
        for (let i = 0; i < 40; i++) res.write(sse({ content: LONG }));
        res.write(sse({}, { finish_reason: 'stop' }));
        res.end('data: [DONE]\n\n');
    });
});
await new Promise((r) => fake.listen(9998, '0.0.0.0', r));

const rssMiB = () =>
    new Promise((resolve) =>
        execFile('docker', ['exec', container, 'sh', '-c', 'grep VmRSS /proc/1/status'], (err, out) => {
            const kb = Number(/(\d+)/.exec(out ?? '')?.[1]);
            resolve(err || !Number.isFinite(kb) ? null : kb / 1024);
        }),
    );

let peak = 0;
let sampling = true;
const sampler = (async () => {
    while (sampling) {
        const v = await rssMiB();
        if (v !== null && v > peak) peak = v;
        await new Promise((r) => setTimeout(r, 200));
    }
})();

let failed = false;
try {
    const setup = await fetch(`${api}/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple', setupCode }),
    });
    const cookies = setup.headers.getSetCookie().map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith('aip_csrf='))?.split('=')[1] ?? '';
    const tokenRes = await fetch(`${api}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': csrf },
        body: JSON.stringify({ name: 'chat-peak' }),
    });
    const { token } = await tokenRes.json();
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await fetch(`${api}/models`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
            label: 'peak',
            kind: 'openai-compatible',
            baseURL: `${fakeInContainer}/v1`,
            apiKeyRef: 'env:PEAK_KEY',
            model: 'peak',
            purpose: ['chat'],
        }),
    });
    const idleBefore = await rssMiB();
    let finished = 0;
    for (let s = 0; s < SESSIONS; s++) {
        const session = await (await fetch(`${api}/sessions`, { method: 'POST', headers: auth, body: '{}' })).json();
        for (let t = 0; t < TURNS; t++) {
            const res = await fetch(`${api}/sessions/${session.id}/messages`, {
                method: 'POST',
                headers: auth,
                body: JSON.stringify({ text: `请计算并详细说明(第 ${s + 1}-${t + 1} 轮)` }),
            });
            const text = await res.text();
            if (text.includes('run-finished')) finished += 1;
        }
    }
    sampling = false;
    await sampler;
    await new Promise((r) => setTimeout(r, 60_000));
    const idleAfter = await rssMiB();
    const turns = SESSIONS * TURNS;
    console.log(
        `turns ${finished}/${turns}, model calls ${modelCalls}, idle before ${idleBefore?.toFixed(1)} MiB, peak ${peak.toFixed(1)} MiB, idle 60 s after ${idleAfter?.toFixed(1)} MiB, cap ${CAP_MIB} MiB`,
    );
    if (finished !== turns || modelCalls < turns * 2) {
        console.log('FAIL: not every turn finished with a tool call and a reply');
        failed = true;
    }
    // ADR 0041:峰值只报告,不拦截
    if (peak >= CAP_MIB)
        console.log(`NOTE: peak ${peak.toFixed(1)} MiB is not under the old ${CAP_MIB} MiB figure (report only)`);
} finally {
    sampling = false;
    fake.close();
}
process.exit(failed ? 1 : 0);

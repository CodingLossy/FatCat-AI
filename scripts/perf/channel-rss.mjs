// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道内存压测(ADR 0018 第 5 节,M5a PR 8):起假的微信 iLink 服务器与构建好的服务器(apps/server/dist),
// 先测不配渠道的空闲内存,再走真实流程(建渠道、扫码、配对、启用)配好微信渠道,测配置后的空闲内存,
// 两者之差就是该渠道的增量;然后让「主人」发 MESSAGES 条普通文字消息,每条都走完整的一轮对话
// (收消息、去重、限流、入队、runs.start、模型流式输出、写消息与会话、回复文本),等回复收齐后空闲 SETTLE_S 秒,连跑 RUNS 次。
// 模型是本地假的 OpenAI 兼容端点(fake-openai.mjs),通过真实的模型配置档接入,不调用外网。
// 服务器代码不改:ilink-redirect.mjs 以 --import 预加载,把发往 iLink 默认地址的请求改到本地假端点。
// 主人消息每分钟最多 20 条(ADR 0022 第 4 节),所以按 PACE_MS 间隔发送,默认每 3.4 秒一条(约 17.6 条/分钟)。
// Linux 读 /proc/<pid>/status 的 VmRSS;Windows 读 WorkingSet64。
//
//   node scripts/perf/channel-rss.mjs                     # 测量并打印,不判定
//   MESSAGES=20 RUNS=1 SETTLE_S=10 node scripts/perf/channel-rss.mjs
//   CHECK=1 node scripts/perf/channel-rss.mjs             # 按规则 3、4、5 判定,不满足时退出码 1(CI 用)
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { capFromMeasured, evaluateChannel } from './budget.mjs';
import { startFakeIlink } from './fake-ilink.mjs';
import { startFakeOpenAI } from './fake-openai.mjs';

const MESSAGES = Number(process.env.MESSAGES ?? 100);
const RUNS = Number(process.env.RUNS ?? 3);
const SETTLE_S = Number(process.env.SETTLE_S ?? 60);
const PACE_MS = Number(process.env.PACE_MS ?? 3400);
const SAMPLE_GAP_MS = Number(process.env.SAMPLE_GAP_MS ?? 5000);
const CHECK = process.env.CHECK === '1';
const WINDOWS = process.platform === 'win32';
const root = fileURLToPath(new URL('../../', import.meta.url));

if (process.platform !== 'linux' && !WINDOWS) {
    console.error('channel-rss: only Linux and Windows are supported');
    process.exit(2);
}

// 与容器一致的 Node 参数:取自 docker/Dockerfile 的 NODE_OPTIONS,NODE_FLAGS 可覆盖(空格分隔)
const NODE_FLAGS = (
    process.env.NODE_FLAGS ??
    /NODE_OPTIONS="([^"]+)"/.exec(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'))?.[1] ??
    ''
)
    .split(/\s+/)
    .filter(Boolean);

const round1 = (n) => Math.round(n * 10) / 10;

function memory(pid) {
    if (WINDOWS) {
        const out = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`],
            { encoding: 'utf8' },
        );
        return round1(Number(out.trim()) / 1048576);
    }
    const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return round1(Number(kb) / 1024);
}

/** 3 次采样的中位数(ADR 0018 第 4 节)。 */
async function sample(pid) {
    const values = [];
    for (let i = 0; i < 3; i++) {
        if (i > 0) await sleep(SAMPLE_GAP_MS);
        values.push(memory(pid));
    }
    return values.sort((a, b) => a - b)[1];
}

function freePort() {
    return new Promise((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

const baseline = JSON.parse(readFileSync(join(root, '.github/memory-baseline.json'), 'utf8'));
const incrementCap = baseline.channelIncrementMiB?.wechat;
if (CHECK && !Number.isFinite(incrementCap)) {
    console.error('channel-rss: .github/memory-baseline.json has no channelIncrementMiB.wechat');
    process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'fatcat-channel-rss-'));
const ilink = await startFakeIlink();
const model = await startFakeOpenAI();
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
    process.execPath,
    [...NODE_FLAGS, '--import', fileURLToPath(new URL('./ilink-redirect.mjs', import.meta.url)), 'dist/index.js'],
    {
        cwd: join(root, 'apps/server'),
        env: {
            ...process.env,
            NODE_ENV: 'production',
            FATCAT_AI_HOST: '127.0.0.1',
            FATCAT_AI_PORT: String(port),
            FATCAT_AI_DATA_DIR: join(dir, 'data'),
            FATCAT_AI_LOG_LEVEL: 'warn',
            FATCAT_AI_PERF_ILINK_URL: ilink.url,
            PERF_MODEL_KEY: 'perf-fake-key',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    },
);

let cookie = '';
let csrf = '';
async function api(method, path, body) {
    const res = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie();
    if (set.length > 0) {
        const pairs = set.map((c) => c.split(';')[0]);
        cookie = pairs.join('; ');
        csrf = pairs.find((p) => p.startsWith('aip_csrf='))?.slice('aip_csrf='.length) ?? csrf;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function until(what, fn, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
}

let cleaned = false;
async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    server.kill();
    await ilink.close();
    await model.close();
    rmSync(dir, { recursive: true, force: true });
}
for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
]) {
    process.once(signal, () => {
        void cleanup().finally(() => process.exit(code));
    });
}

try {
    await until('the server to start', async () => {
        try {
            return (await fetch(`${origin}/healthz`)).ok;
        } catch {
            return false;
        }
    });
    await api('POST', '/auth/setup', { username: 'owner', password: 'perf-test-password-1' });
    await sleep(10_000); // 与 CI 的空闲测量一致:启动后 10 秒
    const pid = server.pid;
    console.log(`node flags: ${NODE_FLAGS.join(' ')}`);
    const idleWithout = await sample(pid);
    console.log(`idle without a channel: ${idleWithout} MiB`);

    // 模型配置档指向假的 OpenAI 兼容端点;密钥用 env: 引用(ADR 0006),不写明文
    await api('POST', '/models', {
        label: 'perf-model',
        kind: 'openai-compatible',
        baseURL: model.url,
        apiKeyRef: 'env:PERF_MODEL_KEY',
        model: 'perf-model',
        purpose: ['chat'],
    });

    // 真实流程:建渠道 → 扫码(假端点立刻确认)→ 配对码 → 启用 → 主人发「绑定」
    const channel = await api('POST', '/channels', { kind: 'wechat', label: 'perf' });
    await api('POST', `/channels/${channel.id}/wechat/login`);
    await until(
        'the QR login',
        async () => (await api('GET', `/channels/${channel.id}/wechat/login`)).state === 'confirmed',
    );
    const pairing = await api('POST', `/channels/${channel.id}/pairing`);
    await api('PATCH', `/channels/${channel.id}`, { enabled: true });
    await until(
        'the channel to run',
        async () => (await api('GET', `/channels/${channel.id}/status`)).state === 'running',
    );
    ilink.push(`绑定 ${pairing.code}`);
    await until('the owner binding', async () => (await api('GET', `/channels/${channel.id}`)).binding !== null);
    await until('the pairing reply', () => ilink.sent() >= 1);
    await sleep(SETTLE_S * 1000); // 配置过程(扫码、写 secrets.yaml、首批请求)的临时内存先落下来,再测增量
    const idleWith = await sample(pid);
    const increment = round1(idleWith - idleWithout);
    console.log(`idle with the WeChat channel bound and polling: ${idleWith} MiB (+${increment})`);

    const settled = [];
    const runs = [];
    for (let run = 1; run <= RUNS; run++) {
        const sentBefore = ilink.sent();
        const turnsBefore = model.turns();
        const started = Date.now();
        for (let i = 0; i < MESSAGES; i++) {
            ilink.push(`第 ${run}.${i + 1} 条:你好,今天怎么样?`);
            await sleep(PACE_MS);
        }
        await until('all replies', () => ilink.sent() - sentBefore >= MESSAGES, 60_000);
        const modelTurns = model.turns() - turnsBefore;
        if (modelTurns < MESSAGES)
            throw new Error(`run ${run}: only ${modelTurns} model calls for ${MESSAGES} messages`);
        const seconds = Math.round((Date.now() - started) / 1000);
        const status = await api('GET', `/channels/${channel.id}/status`);
        if (status.rateLimitedCount > 0)
            throw new Error(`${status.rateLimitedCount} messages were rate limited; raise PACE_MS`);
        const after = await sample(pid);
        await sleep(SETTLE_S * 1000);
        const rss = await sample(pid);
        settled.push(rss);
        runs.push({ run, messages: MESSAGES, modelTurns, seconds, after, settled: rss });
        console.log(
            `run ${run}: ${MESSAGES} conversation turns (${modelTurns} model calls) in ${seconds}s, after ${after}, after ${SETTLE_S}s ${rss} MiB`,
        );
    }
    console.log(
        JSON.stringify({
            platform: process.platform,
            idleWithout,
            idleWith,
            increment,
            settleSeconds: SETTLE_S,
            runs,
        }),
    );
    console.log(`suggested cap (measured x 1.5, up to 5 MiB): ${capFromMeasured(increment)} MiB`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `Channel wechat: +${increment} MiB idle (cap ${incrementCap ?? 'not set'}); settled ${settled.join(' / ')} MiB\n`,
        );
    }
    if (CHECK) {
        const { errors } = evaluateChannel({ idleWithout, idleWith, settled, incrementCap });
        for (const e of errors) console.log(`::error::${e}`);
        if (errors.length === 0) console.log(`ADR 0018 rules 3${settled.length >= 3 ? ', 4' : ''} and 5: passed`);
        process.exitCode = errors.length > 0 ? 1 : 0;
    }
} finally {
    await cleanup();
}

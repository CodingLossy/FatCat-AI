// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音往返的额外开销与内存(M4 方案 PR 6、ADR 0021、ADR 0018)。
// 假端点固定延迟:转写 300 ms、模型首字 300 ms、朗读首字节 300 ms;一次往返的墙钟时间减去这些延迟,
// 就是 FatCat-AI 自己的额外开销,验收线 < 1 秒。真实端点的延迟由业主侧补测。
// 内存在测试进程内测量(包含 vitest 自身),按 ADR 0018 第 4 节的思路:连跑 3 轮负载,
// 每轮后回落到负载前 + 60 MiB 以内,第 3 轮后比第 2 轮后多 ≤ 5 MiB。空闲 RSS 由 CI 的容器门禁测量。
// 负载每轮 50 次往返,不加延迟;会话里的消息随之增加,所以堆会略涨(每轮约 0.3 MiB)。
import { performance } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { ChatChunk, ModelProvider } from '@fatcat-ai/providers';
import { Session } from '@fatcat-ai/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';
import { WindowLimiter } from './voice-limit.js';

const DELAY_MS = 300;
/** 内存负载不需要延迟,只在测开销时打开。 */
let delay = DELAY_MS;
const ROUND_TRIPS = 5;
const LOAD_ROUNDS = 3;
const LOAD_TRIPS = 50;
const MiB = 1048576;
/** 约 48 KiB 的录音(WebM 头 + 填充),大约 3 秒的 Opus。 */
const AUDIO = new Uint8Array(48 * 1024);
AUDIO.set([0x1a, 0x45, 0xdf, 0xa3]);
/** 朗读返回约 64 KiB 的 MP3,分 16 块。 */
const SPEECH_CHUNK = new Uint8Array(4096).fill(0x55);
SPEECH_CHUNK.set([0x49, 0x44, 0x33]);
const ANSWER = '好的,会议改到下午四点,我已经记下了。';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await wait(delay);
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: '把会议改到下午四点' });
    if (url.endsWith('/audio/speech')) {
        let sent = 0;
        return new Response(
            new ReadableStream({
                pull(c) {
                    if (sent++ < 16) c.enqueue(SPEECH_CHUNK);
                    else c.close();
                },
            }),
            { headers: { 'content-type': 'audio/mpeg' } },
        );
    }
    return new Response('not found', { status: 404 });
};

const provider: ModelProvider = {
    profileId: 'fake',
    stream: async function* (): AsyncGenerator<ChatChunk> {
        await wait(delay);
        for (const ch of ANSWER) yield { type: 'text-delta', delta: ch };
        yield { type: 'finish', reason: 'stop' };
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
};

let s: TestServer;
afterAll(async () => {
    await s?.cleanup();
});

async function setup() {
    s = await createTestServer(
        {},
        {
            fetch: fakeFetch,
            provider,
            env: { VOICE_KEY: 'sk-voice-perf-0123456789' },
            voice: {
                limits: { transcribe: new WindowLimiter(1000, 60_000), speak: new WindowLimiter(1000, 60_000) },
            },
        },
    );
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf };
    const postJson = (path: string, body: unknown = {}) =>
        s.app.request(path, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { ...headers, 'content-type': 'application/json' },
        });
    const profile = (body: Record<string, unknown>) =>
        postJson('/api/v1/models', {
            kind: 'openai-compatible',
            baseURL: 'http://voice.test/v1',
            apiKeyRef: 'env:VOICE_KEY',
            ...body,
        });
    await profile({ label: 'chat', model: 'm', purpose: ['chat'] });
    await profile({ label: 'stt', model: 'whisper-1', purpose: ['stt'] });
    await profile({ label: 'tts', model: 'tts-1', purpose: ['tts'] });
    const session = Session.parse(await (await postJson('/api/v1/sessions')).json());

    /** 一次往返:转写 → 发消息并读完回复 → 朗读到最后一个字节。返回额外开销与首字节时刻。 */
    async function roundTrip() {
        const start = performance.now();
        const form = new FormData();
        form.append('file', new File([AUDIO], 'voice.webm', { type: 'audio/webm' }));
        const tr = await s.app.request('/api/v1/voice/transcriptions', { method: 'POST', body: form, headers });
        expect(tr.status).toBe(200);
        const { text } = (await tr.json()) as { text: string };
        const reply = await postJson(`/api/v1/sessions/${session.id}/messages`, { text });
        expect(reply.status).toBe(200);
        await reply.text();
        const speech = await postJson('/api/v1/voice/speech', { text: ANSWER });
        expect(speech.status).toBe(200);
        const reader = speech.body!.getReader();
        let firstByteAt = 0;
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!firstByteAt) firstByteAt = performance.now();
            bytes += value.byteLength;
        }
        expect(bytes).toBe(16 * SPEECH_CHUNK.byteLength);
        const toFirstByte = firstByteAt - start;
        return { overhead: toFirstByte - 3 * DELAY_MS, total: performance.now() - start };
    }
    return { roundTrip };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// 测试进程默认没有 --expose-gc;在新上下文里取 gc,让「回落」测的是真的保留,而不是还没回收的垃圾
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

async function settled() {
    for (let i = 0; i < 3; i++) {
        gc();
        await wait(200);
    }
    const { rss, heapUsed } = process.memoryUsage();
    return { rss, heap: heapUsed };
}

describe('语音往返', () => {
    it(`额外开销 < 1 秒(假端点 3 × ${DELAY_MS} ms),${LOAD_ROUNDS} 轮负载后内存回落`, async () => {
        const { roundTrip } = await setup();
        await roundTrip(); // 预热:首次加载模块、编译正则等

        const overheads: number[] = [];
        for (let i = 0; i < ROUND_TRIPS; i++) overheads.push((await roundTrip()).overhead);
        const worst = Math.max(...overheads);

        delay = 0;
        const before = await settled();
        const after: { rss: number; heap: number }[] = [];
        for (let round = 0; round < LOAD_ROUNDS; round++) {
            for (let i = 0; i < LOAD_TRIPS; i++) await roundTrip();
            after.push(await settled());
        }
        const mb = (n: number) => (n / MiB).toFixed(1);
        console.log(
            `[perf] voice round trip overhead median ${median(overheads).toFixed(0)} ms, worst ${worst.toFixed(0)} ms; ` +
                `RSS before ${mb(before.rss)} MiB, after rounds ${after.map((m) => mb(m.rss)).join(' / ')} MiB; ` +
                `heap before ${mb(before.heap)} MiB, after rounds ${after.map((m) => mb(m.heap)).join(' / ')} MiB`,
        );
        expect(worst).toBeLessThan(1000);
        // ADR 0018 规则 3:每轮后 RSS 比负载前多 ≤ 60 MiB。规则 4(第 3 轮后比第 2 轮后多 ≤ 5 MiB)看堆:
        // 测试进程的 RSS 受覆盖率插桩与分配器影响,两轮之间能差 15 MiB 以上,堆在 gc 后稳定
        for (const m of after) expect(m.rss - before.rss).toBeLessThan(60 * MiB);
        expect(after[2]!.heap - after[1]!.heap).toBeLessThan(5 * MiB);
    }, 300_000);
});

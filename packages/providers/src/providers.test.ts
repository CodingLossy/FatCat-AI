// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayFetch, fixtureFetch, loadFixture } from '@ai-personal/eval';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { Redactor } from './redact.js';
import { createProvider, selectProfile } from './registry.js';
import { parseSecretsFile, SecretStore } from './secrets.js';
import { type ChatChunk, ProviderError, type ProviderProfile } from './types.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const fixture = (name: string) => join(FIXTURES, `${name}.json`);

const LIVE = process.env.AIP_EVAL_LIVE === '1';
const BASE = LIVE ? (process.env.AIP_EVAL_BASE_URL ?? '') : 'http://fixture.test/v1';
const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
    id: '01JC0000000000000000000000',
    kind: 'openai-compatible',
    baseURL: BASE,
    apiKeyRef: LIVE ? `env:${process.env.AIP_EVAL_KEY_ENV ?? 'OPENAI_API_KEY'}` : null,
    model: LIVE ? (process.env.AIP_EVAL_MODEL ?? '') : 'qwen3:8b',
    purpose: ['chat'],
    ...over,
});

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
}

const text = (chunks: ChatChunk[]) =>
    chunks
        .filter((c): c is Extract<ChatChunk, { type: 'text-delta' }> => c.type === 'text-delta')
        .map((c) => c.delta)
        .join('');

const noSleep = () => Promise.resolve();

function provider(fetchImpl: typeof fetch, over: Partial<ProviderProfile> = {}, key: string | null = null) {
    const redactor = new Redactor();
    redactor.add(key);
    return {
        redactor,
        p: createOpenAICompatibleProvider({
            profile: profile(over),
            getApiKey: () => key,
            redactor,
            fetch: fetchImpl,
            sleep: noSleep,
        }),
    };
}

/** 内联 fetch 桩:按调用顺序返回给定的响应。 */
function stubFetch(...responses: (() => Response | Promise<Response>)[]) {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const f: typeof fetch = (input, init) => {
        calls.push({ url: String(input), init });
        const next = responses.shift();
        if (!next) return Promise.reject(new Error('no more stubbed responses'));
        return Promise.resolve(next());
    };
    return { fetch: f, calls };
}

describe('OpenAI 兼容流式(录制回放)', () => {
    it('OpenAI 风格:逐段输出文本,结束时带 usage', async () => {
        const redactor = new Redactor();
        const secrets = new SecretStore({ dataDir: tmpdir(), redactor });
        const replay = fixtureFetch(fixture('openai-stream'), { redact: (t) => redactor.redact(t) });
        const p = createProvider(profile(), { secrets, redactor, fetch: replay.fetch, sleep: noSleep });
        const chunks = await collect(p.stream({ messages: [{ role: 'user', content: '用两个词问好' }] }));
        replay.done();
        if (LIVE) return;

        expect(text(chunks)).toBe('你好,世界');
        expect(chunks.at(-1)).toEqual({
            type: 'finish',
            reason: 'stop',
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        });
        const body = replay.calls![0]!.body as Record<string, unknown>;
        expect(body).toMatchObject({ model: 'qwen3:8b', stream: true, stream_options: { include_usage: true } });
        expect(replay.calls![0]!.headers.get('authorization')).toBeNull(); // apiKeyRef 为 null 时不带密钥
    });

    it('Ollama 风格:CRLF、跨块切断的事件、注释行、没有 usage', async () => {
        const replay = createReplayFetch(loadFixture(fixture('ollama-stream')));
        const { p } = provider(replay.fetch);
        const chunks = await collect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }));
        expect(text(chunks)).toBe('Hello');
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    });

    it('工具调用:合并分段参数,按 tool-calls 结束', async () => {
        const replay = createReplayFetch(loadFixture(fixture('tool-call-stream')));
        const { p } = provider(replay.fetch);
        const chunks = await collect(
            p.stream({
                messages: [{ role: 'user', content: '记住我住杭州' }],
                tools: [{ name: 'memory.save', description: 'save', parameters: { type: 'object' } }],
            }),
        );
        expect(chunks.filter((c) => c.type === 'tool-call')).toEqual([
            { type: 'tool-call', callId: 'call_abc', name: 'memory.save', input: { text: '用户常住杭州' } },
        ]);
        expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'tool-calls' });
        expect((replay.calls[0]!.body as { tools: unknown[] }).tools).toHaveLength(1);
    });

    it('连接测试读取 /models', async () => {
        const redactor = new Redactor();
        const replay = fixtureFetch(fixture('models-list'), { redact: (t) => redactor.redact(t) });
        const p = createProvider(profile(), {
            secrets: new SecretStore({ dataDir: tmpdir(), redactor }),
            redactor,
            fetch: replay.fetch,
        });
        const result = await p.test();
        replay.done();
        expect(result.ok).toBe(true);
        if (!LIVE && result.ok) expect(result.models).toEqual(['qwen3:8b', 'llama3.2:3b']);
    });
});

describe('OpenAI 兼容嵌入 /embeddings(回放)', () => {
    it('按 index 排回输入顺序,返回模型名与 usage', async () => {
        const replay = createReplayFetch(loadFixture(fixture('embeddings')));
        const { p } = provider(replay.fetch, { purpose: ['embed'], model: 'text-embedding-3-small' });
        const result = await p.embed!(['苹果', 'banana']);
        expect(result.vectors.map((v) => [...v])).toEqual([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
        ]);
        expect(result).toMatchObject({ model: 'text-embedding-3-small', usage: { inputTokens: 6, totalTokens: 6 } });
        expect(replay.calls[0]!.body).toEqual({
            model: 'text-embedding-3-small',
            input: ['苹果', 'banana'],
            encoding_format: 'float',
        });
    });

    it('条数不符、维度不一致、批量越界与上游错误都报错', async () => {
        const json = (data: unknown) => () =>
            new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
        const short = provider(stubFetch(json([{ index: 0, embedding: [1, 2] }])).fetch);
        await expect(short.p.embed!(['a', 'b'])).rejects.toMatchObject({ code: 'upstream_error' });
        const ragged = provider(
            stubFetch(
                json([
                    { index: 0, embedding: [1, 2] },
                    { index: 1, embedding: [1] },
                ]),
            ).fetch,
        );
        await expect(ragged.p.embed!(['a', 'b'])).rejects.toMatchObject({ code: 'upstream_error' });
        const none = provider(stubFetch().fetch);
        await expect(none.p.embed!([])).rejects.toMatchObject({ code: 'bad_request' });
        await expect(none.p.embed!(new Array<string>(65).fill('x'))).rejects.toMatchObject({ code: 'bad_request' });
        const unauthorized = provider(stubFetch(() => new Response('{"error":"bad key"}', { status: 401 })).fetch);
        await expect(unauthorized.p.embed!(['a'])).rejects.toMatchObject({ code: 'auth_failed' });
    });
});

describe('DeepSeek 真实录制(回放)', () => {
    const deepseek = (over: Partial<ProviderProfile> = {}) =>
        profile({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', ...over });

    it('流式对话:中文文本与 usage', async () => {
        const replay = createReplayFetch(loadFixture(fixture('deepseek-chat-stream')));
        const { p } = provider(replay.fetch, deepseek());
        const chunks = await collect(p.stream({ messages: [{ role: 'user', content: '请只回复四个字:你好世界' }] }));
        expect(text(chunks)).toBe('你好世界');
        const finish = chunks.at(-1) as Extract<ChatChunk, { type: 'finish' }>;
        expect(finish.reason).toBe('stop');
        expect(finish.usage?.inputTokens).toBeGreaterThan(0);
        expect(finish.usage?.outputTokens).toBeGreaterThan(0);
    });

    it('工具调用:发送时用 memory__save,收到后还原为 memory.save', async () => {
        const replay = createReplayFetch(loadFixture(fixture('deepseek-tool-call-stream')));
        const { p } = provider(replay.fetch, deepseek());
        const chunks = await collect(
            p.stream({
                messages: [{ role: 'user', content: 'Please remember: I live in Hangzhou.' }],
                tools: [{ name: 'memory.save', description: 'save', parameters: { type: 'object' } }],
            }),
        );
        const calls = chunks.filter((c) => c.type === 'tool-call');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'memory.save' });
        expect(JSON.stringify((calls[0] as { input: unknown }).input)).toMatch(/Hangzhou/);
        expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'tool-calls' });
        const sent = replay.calls[0]!.body as { tools: { function: { name: string } }[] };
        expect(sent.tools[0]!.function.name).toBe('memory__save');
    });

    it('连接测试与无效密钥', async () => {
        const models = createReplayFetch(loadFixture(fixture('deepseek-models')));
        const ok = await provider(models.fetch, deepseek()).p.test();
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.models!.length).toBeGreaterThan(0);

        const denied = createReplayFetch(loadFixture(fixture('deepseek-auth-error')));
        const error = (await collect(provider(denied.fetch, deepseek()).p.stream({ messages: [] })).catch(
            (e: unknown) => e,
        )) as ProviderError;
        expect(error.code).toBe('auth_failed');
        expect(error.status).toBe(401);
    });
});

describe('错误、重试与取消', () => {
    it.each([
        [401, 'auth_failed'],
        [403, 'auth_failed'],
        [404, 'not_found'],
        [400, 'bad_request'],
        [422, 'bad_request'],
    ] as const)('HTTP %i 归类为 %s,不重试', async (status, code) => {
        const stub = stubFetch(() => new Response('{"error":{"message":"nope"}}', { status }));
        const { p } = provider(stub.fetch);
        const error = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }] })).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).code).toBe(code);
        expect(stub.calls).toHaveLength(1);
    });

    it('429 / 5xx 在没有任何输出前重试一次', async () => {
        const ok = loadFixture(fixture('openai-stream')).interactions[0]!.response;
        const stub = stubFetch(
            () => new Response('busy', { status: 503 }),
            () => new Response(ok.chunks.join(''), { status: 200, headers: ok.headers }),
        );
        const { p } = provider(stub.fetch);
        expect(text(await collect(p.stream({ messages: [{ role: 'user', content: 'x' }] })))).toBe('你好,世界');
        expect(stub.calls).toHaveLength(2);
    });

    it('重试后仍失败则报错;连接错误归类为 network_error', async () => {
        const rate = stubFetch(
            () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
            () => new Response('slow down', { status: 429 }),
        );
        const e1 = await collect(provider(rate.fetch).p.stream({ messages: [] })).catch((e: unknown) => e);
        expect((e1 as ProviderError).code).toBe('rate_limited');

        const down = stubFetch(
            () => Promise.reject(new TypeError('fetch failed')),
            () => Promise.reject(new TypeError('fetch failed')),
        );
        const e2 = await collect(provider(down.fetch).p.stream({ messages: [] })).catch((e: unknown) => e);
        expect((e2 as ProviderError).code).toBe('network_error');
    });

    it('流中的 error 对象与损坏的数据报 upstream_error', async () => {
        for (const body of ['data: {"error":{"message":"overloaded"}}\n\n', 'data: {not json\n\n']) {
            const stub = stubFetch(() => new Response(body, { status: 200 }));
            const e = await collect(provider(stub.fetch).p.stream({ messages: [] })).catch((x: unknown) => x);
            expect((e as ProviderError).code).toBe('upstream_error');
        }
    });

    it('首个数据块超时报 timeout', async () => {
        const hang: typeof fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        const redactor = new Redactor();
        const p = createOpenAICompatibleProvider({
            profile: profile(),
            getApiKey: () => null,
            redactor,
            fetch: hang,
            firstTokenTimeoutMs: 20,
            sleep: noSleep,
        });
        const e = await collect(p.stream({ messages: [] })).catch((x: unknown) => x);
        expect((e as ProviderError).code).toBe('timeout');
    });

    it('用户取消时以 aborted 结束,不抛错', async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const slow: typeof fetch = (_input, init) =>
            Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
                            init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
                        },
                    }),
                    { status: 200 },
                ),
            );
        const { p } = provider(slow);
        const chunks: ChatChunk[] = [];
        for await (const c of p.stream({ messages: [], signal: controller.signal })) {
            chunks.push(c);
            if (c.type === 'text-delta') controller.abort();
        }
        expect(chunks).toEqual([
            { type: 'text-delta', delta: '部分' },
            { type: 'finish', reason: 'aborted' },
        ]);
    });
});

describe('密钥不泄露', () => {
    it('上游在错误里回显密钥时,错误信息中只有 [REDACTED]', async () => {
        const stub = stubFetch(
            () =>
                new Response(`{"error":{"message":"Incorrect API key provided: ${FAKE_KEY}. Bearer ${FAKE_KEY}"}}`, {
                    status: 401,
                }),
        );
        const { p } = provider(stub.fetch, {}, FAKE_KEY);
        const error = (await collect(p.stream({ messages: [] })).catch((e: unknown) => e)) as ProviderError;
        expect(error.code).toBe('auth_failed');
        expect(error.message).not.toContain(FAKE_KEY);
        expect(error.message).toContain('[REDACTED]');
        // 密钥只出现在 Authorization 头中
        expect(new Headers(stub.calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    });

    it('连接测试失败的消息同样脱敏;引用的密钥缺失时报 key_missing', async () => {
        const stub = stubFetch(() => new Response(`bad key ${FAKE_KEY}`, { status: 401 }));
        const result = await provider(stub.fetch, { apiKeyRef: 'env:X' }, FAKE_KEY).p.test();
        expect(result).toMatchObject({ ok: false, error: 'auth_failed' });
        expect(JSON.stringify(result)).not.toContain(FAKE_KEY);

        const missing = await provider(stubFetch().fetch, { apiKeyRef: 'env:NOT_SET' }, null).p.test();
        expect(missing).toMatchObject({ ok: false, error: 'key_missing' });
    });

    it('录制的 fixture 中没有密钥', () => {
        const redactor = new Redactor();
        redactor.add(FAKE_KEY);
        expect(redactor.redact(`{"k":"${FAKE_KEY}","h":"Bearer abcdefghijkl"}`)).toBe(
            '{"k":"[REDACTED]","h":"Bearer [REDACTED]"}',
        );
    });
});

describe('密钥引用 env: / file:', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'aip-secrets-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('从环境变量与 secrets.yaml 读取,并登记到脱敏器', () => {
        writeFileSync(
            join(dir, 'secrets.yaml'),
            '# comment\ndeepseek: "sk-file-value-123456"\nplain: abc12345 # trailing\n',
        );
        const redactor = new Redactor();
        const store = new SecretStore({ dataDir: dir, redactor, env: { DEEPSEEK_API_KEY: 'sk-env-value-123456' } });
        expect(store.resolve('env:DEEPSEEK_API_KEY')).toBe('sk-env-value-123456');
        expect(store.resolve('file:deepseek')).toBe('sk-file-value-123456');
        expect(store.resolve('file:plain')).toBe('abc12345');
        expect(store.status('env:MISSING')).toBe('missing');
        expect(store.status(null)).toBe('not_required');
        expect(store.status('plaintext-key')).toBe('missing');
        expect(redactor.redact('x abc12345 y')).toBe('x [REDACTED] y');
    });

    it('secrets.yaml 只接受扁平映射', () => {
        expect(() => parseSecretsFile('a:\n  b: c\n')).toThrow(/nested/);
        expect(() => parseSecretsFile('- item\n')).toThrow(/NAME: value/);
        expect(parseSecretsFile("k: 'v # not a comment'\n").get('k')).toBe('v # not a comment');
    });
});

describe('selectProfile', () => {
    const a = profile({ id: 'A', purpose: ['chat'] });
    const b = profile({ id: 'B', purpose: ['cheap'] });

    it('优先用默认值;cheap 缺失时回退到 chat', () => {
        expect(selectProfile([a, b], 'chat')?.id).toBe('A');
        expect(selectProfile([a, b], 'cheap')?.id).toBe('B');
        expect(selectProfile([a], 'cheap')?.id).toBe('A');
        expect(selectProfile([a, b], 'chat', { chat: 'B' })?.id).toBe('B');
        expect(selectProfile([], 'chat')).toBeNull();
    });
});

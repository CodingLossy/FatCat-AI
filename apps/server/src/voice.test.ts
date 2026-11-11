// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音接口(ADR 0021):假端点上的成功、超时、上游错误、超限、限流,以及日志里没有音频与文字。
import { MAX_TRANSCRIPTION_BYTES, ProblemDetails, TranscriptionResult } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';
import { WindowLimiter } from './voice-limit.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

const KEY = 'sk-voice-test-0123456789';
const TRANSCRIPT = '今天下午三点开会';
const SPOKEN = '会议改到四点';
/** 合成的 WebM(EBML 头)与 WAV 头,后面跟随意字节;假端点不解码。 */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface Seen {
    url: string;
    headers: Record<string, string>;
    form?: FormData;
    json?: Record<string, unknown>;
}

type Reply = (seen: Seen, signal: AbortSignal) => Response | Promise<Response>;

function fakeEndpoint(reply: { stt?: Reply; tts?: Reply } = {}) {
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const entry: Seen = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()) };
        if (init?.body instanceof FormData) entry.form = init.body;
        else if (typeof init?.body === 'string') entry.json = JSON.parse(init.body) as Record<string, unknown>;
        seen.push(entry);
        const signal = init?.signal ?? new AbortController().signal;
        if (url.endsWith('/audio/transcriptions')) {
            return (reply.stt ?? (() => Response.json({ text: `  ${TRANSCRIPT}\n` })))(entry, signal);
        }
        if (url.endsWith('/audio/speech')) {
            return (
                reply.tts ??
                (() =>
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(new Uint8Array([0x49, 0x44, 0x33, 1]));
                                c.enqueue(new Uint8Array([2, 3, 4]));
                                c.close();
                            },
                        }),
                        { headers: { 'content-type': 'audio/mpeg' } },
                    ))
            )(entry, signal);
        }
        return new Response('not found', { status: 404 });
    };
    return { seen, fetchImpl };
}

/** 等到调用方中止;用来模拟不回应的端点。 */
const hang = (_: Seen, signal: AbortSignal) =>
    new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });

async function setup(
    options: {
        reply?: { stt?: Reply; tts?: Reply };
        perMinute?: number;
        timeouts?: { transcribeTimeoutMs?: number; speechFirstByteTimeoutMs?: number; speechIdleTimeoutMs?: number };
        profiles?: boolean;
    } = {},
) {
    const endpoint = fakeEndpoint(options.reply);
    const perMinute = options.perMinute ?? 20;
    s = await createTestServer(
        {},
        {
            fetch: endpoint.fetchImpl,
            env: { VOICE_KEY: KEY },
            voice: {
                limits: {
                    transcribe: new WindowLimiter(perMinute, 60_000),
                    speak: new WindowLimiter(perMinute, 60_000),
                },
                ...(options.timeouts ? { timeouts: options.timeouts } : {}),
            },
        },
    );
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const auth = { cookie, 'X-CSRF-Token': csrf };
    const req = (path: string, init: RequestInit = {}) =>
        s.app.request(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    const sendJson = (path: string, body: unknown, method = 'POST') =>
        req(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const profile = async (body: Record<string, unknown>) =>
        sendJson('/api/v1/models', {
            label: 'voice',
            kind: 'openai-compatible',
            baseURL: 'http://voice.test/v1',
            apiKeyRef: 'env:VOICE_KEY',
            model: 'whisper-1',
            purpose: ['stt'],
            ...body,
        });
    let sttId = '';
    let ttsId = '';
    if (options.profiles !== false) {
        sttId = ((await (await profile({})).json()) as { id: string }).id;
        ttsId = (
            (await (await profile({ model: 'tts-1', purpose: ['tts'], params: { voice: 'nova' } })).json()) as {
                id: string;
            }
        ).id;
    }
    const transcribe = (bytes: Uint8Array, fields: Record<string, string> = {}) => {
        const form = new FormData();
        form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], 'voice.mp3', { type: 'audio/mpeg' }));
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        return req('/api/v1/voice/transcriptions', { method: 'POST', body: form });
    };
    const speak = (body: unknown) => sendJson('/api/v1/voice/speech', body);
    return { ...endpoint, req, sendJson, profile, sttId, ttsId, transcribe, speak };
}

const problemOf = async (res: Response) => ProblemDetails.parse(await res.json());

describe('POST /api/v1/voice/transcriptions', () => {
    it('sends the recording to the endpoint with the sniffed type and returns trimmed text', async () => {
        const t = await setup();
        const res = await t.transcribe(WEBM);
        expect(res.status).toBe(200);
        expect(TranscriptionResult.parse(await res.json())).toEqual({ text: TRANSCRIPT, profileId: t.sttId });
        const call = t.seen[0]!;
        expect(call.url).toBe('http://voice.test/v1/audio/transcriptions');
        expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(call.form?.get('model')).toBe('whisper-1');
        expect(call.form?.get('response_format')).toBe('json');
        // 界面语言默认 zh-CN
        expect(call.form?.get('language')).toBe('zh');
        const file = call.form?.get('file') as File;
        expect(file.type).toBe('audio/webm');
        expect(file.name).toBe('audio.webm');
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(WEBM);
        // 日志只有元数据
        const logs = s.logs.join('');
        expect(logs).toContain('voice transcription');
        expect(logs).not.toContain(TRANSCRIPT);
        expect(logs).not.toContain(KEY);
    });

    it('passes the language and uses the requested profile', async () => {
        const t = await setup();
        const other = ((await (await t.profile({ label: 'second', model: 'stt-2' })).json()) as { id: string }).id;
        const res = await t.transcribe(WEBM, { language: 'en', profileId: other });
        expect(res.status).toBe(200);
        expect(t.seen[0]!.form?.get('model')).toBe('stt-2');
        expect(t.seen[0]!.form?.get('language')).toBe('en');
    });

    it('rejects non-audio bytes with 415 and oversize bodies with 413, without calling the endpoint', async () => {
        const t = await setup();
        const bad = await t.transcribe(PNG_HEAD);
        expect(bad.status).toBe(415);
        expect((await problemOf(bad)).code).toBe('unsupported_media_type');
        const big = new Uint8Array(MAX_TRANSCRIPTION_BYTES + 1);
        big.set(WEBM);
        const tooLarge = await t.transcribe(big);
        expect(tooLarge.status).toBe(413);
        expect((await problemOf(tooLarge)).code).toBe('payload_too_large');
        expect(t.seen).toHaveLength(0);
    });

    it('maps upstream errors to 502 provider_error and redacts the key', async () => {
        const t = await setup({
            reply: { stt: () => new Response(`invalid key ${KEY}`, { status: 401 }) },
        });
        const res = await t.transcribe(WEBM);
        expect(res.status).toBe(502);
        const body = await problemOf(res);
        expect(body.code).toBe('provider_error');
        expect(body.providerCode).toBe('auth_failed');
        expect(JSON.stringify(body)).not.toContain(KEY);
    });

    it('times out a silent endpoint', async () => {
        const t = await setup({ reply: { stt: hang }, timeouts: { transcribeTimeoutMs: 50 } });
        const res = await t.transcribe(WEBM);
        expect(res.status).toBe(502);
        expect((await problemOf(res)).providerCode).toBe('timeout');
    });

    it('needs a usable stt profile and its key', async () => {
        const t = await setup({ profiles: false });
        const none = await t.transcribe(WEBM);
        expect(none.status).toBe(409);
        expect((await problemOf(none)).code).toBe('model_profile_missing');
        await t.profile({ apiKeyRef: 'env:NOT_SET' });
        const noKey = await t.transcribe(WEBM);
        expect(noKey.status).toBe(409);
        expect((await problemOf(noKey)).code).toBe('model_key_missing');
        const unknown = await t.transcribe(WEBM, { profileId: '01J00000000000000000000000' });
        expect(unknown.status).toBe(404);
        const chat = ((await (await t.profile({ purpose: ['chat'] })).json()) as { id: string }).id;
        const wrong = await t.transcribe(WEBM, { profileId: chat });
        expect(wrong.status).toBe(400);
        expect(t.seen).toHaveLength(0);
    });

    it('requires a session', async () => {
        await setup();
        const form = new FormData();
        form.append('file', new File([WEBM], 'a.webm'));
        const res = await s.app.request('/api/v1/voice/transcriptions', { method: 'POST', body: form });
        expect(res.status).toBe(401);
    });

    it('rate limits per user with Retry-After', async () => {
        const t = await setup({ perMinute: 2 });
        expect((await t.transcribe(WEBM)).status).toBe(200);
        expect((await t.transcribe(WEBM)).status).toBe(200);
        const limited = await t.transcribe(WEBM);
        expect(limited.status).toBe(429);
        expect((await problemOf(limited)).code).toBe('rate_limited');
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        // 朗读单独计数
        expect((await t.speak({ text: '你好' })).status).toBe(200);
        expect(t.seen).toHaveLength(3);
    });
});

describe('POST /api/v1/voice/speech', () => {
    it('streams the endpoint audio with the voice from params', async () => {
        const t = await setup();
        const res = await t.speak({ text: `  ${SPOKEN}  `, format: 'mp3' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]));
        expect(t.seen[0]!.url).toBe('http://voice.test/v1/audio/speech');
        expect(t.seen[0]!.json).toEqual({ model: 'tts-1', input: SPOKEN, voice: 'nova', response_format: 'mp3' });
        const logs = s.logs.join('');
        expect(logs).toContain('voice speech');
        expect(logs).not.toContain(SPOKEN);
    });

    it('defaults the voice and sets the content type per format', async () => {
        const t = await setup();
        const plain = ((await (await t.profile({ label: 'plain', purpose: ['tts'] })).json()) as { id: string }).id;
        const res = await t.speak({ text: 'hi', format: 'opus', profileId: plain });
        expect(res.headers.get('content-type')).toBe('audio/ogg');
        await res.arrayBuffer();
        expect(t.seen[0]!.json).toMatchObject({ voice: 'alloy', response_format: 'opus' });
    });

    it('validates the body', async () => {
        const t = await setup();
        expect((await t.speak({ text: '' })).status).toBe(400);
        expect((await t.speak({ text: 'x'.repeat(4001) })).status).toBe(400);
        expect((await t.speak({ text: 'hi', extra: 1 })).status).toBe(400);
        expect((await t.speak({ text: 'hi', format: 'flac' })).status).toBe(400);
        expect(t.seen).toHaveLength(0);
    });

    it('maps 5xx and first-byte timeouts to 502', async () => {
        const t = await setup({ reply: { tts: () => new Response('boom', { status: 503 }) } });
        const failed = await t.speak({ text: 'hi' });
        expect(failed.status).toBe(502);
        expect((await problemOf(failed)).providerCode).toBe('upstream_error');
        await s.cleanup();
        const slow = await setup({ reply: { tts: hang }, timeouts: { speechFirstByteTimeoutMs: 50 } });
        const res = await slow.speak({ text: 'hi' });
        expect(res.status).toBe(502);
        expect((await problemOf(res)).providerCode).toBe('timeout');
    });
});

describe('voice settings and profiles', () => {
    it('stores voice defaults and rejects profiles that cannot do the job', async () => {
        const t = await setup();
        const ok = await t.sendJson(
            '/api/v1/settings',
            { voice: { defaultSttProfileId: t.sttId, autoSend: false } },
            'PUT',
        );
        expect(ok.status).toBe(200);
        expect(((await ok.json()) as { voice: unknown }).voice).toEqual({
            defaultSttProfileId: t.sttId,
            defaultTtsProfileId: null,
            autoSend: false,
            autoSpeak: false,
        });
        const wrong = await t.sendJson('/api/v1/settings', { voice: { defaultTtsProfileId: t.sttId } }, 'PUT');
        expect(wrong.status).toBe(400);
        const anthropic = await t.profile({ kind: 'anthropic', baseURL: undefined });
        expect(anthropic.status).toBe(400);
    });
});

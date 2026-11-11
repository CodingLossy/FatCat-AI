// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音客户端(ADR 0021):朗读流的逐块转发、块间超时、客户端断开时中止上游请求。
import { describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import { ProviderError } from './types.js';
import { createVoiceClient } from './voice.js';

const profile = {
    id: 'p',
    kind: 'openai-compatible' as const,
    baseURL: 'http://voice.test/v1/',
    apiKeyRef: null,
    model: 'tts-1',
    purpose: ['tts' as const],
};

function client(fetchImpl: typeof fetch, idleMs = 1000) {
    return createVoiceClient({
        profile,
        getApiKey: () => null,
        redactor: new Redactor(),
        fetch: fetchImpl,
        speechIdleTimeoutMs: idleMs,
    });
}

async function readAll(stream: ReadableStream<Uint8Array>) {
    const out: number[] = [];
    for await (const chunk of stream) out.push(...chunk);
    return out;
}

describe('voice client', () => {
    it('forwards chunks as they arrive and trims the base URL', async () => {
        let url = '';
        const stream = await client((input) => {
            url = String(input);
            return Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(new Uint8Array([1]));
                            c.enqueue(new Uint8Array([2, 3]));
                            c.close();
                        },
                    }),
                ),
            );
        }).speak({ text: 'hi', format: 'mp3' });
        expect(await readAll(stream)).toEqual([1, 2, 3]);
        expect(url).toBe('http://voice.test/v1/audio/speech');
    });

    it('errors the stream with timeout when the endpoint stalls between chunks', async () => {
        const stream = await client(
            (_input, init) =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(new Uint8Array([1]));
                                init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
                            },
                        }),
                    ),
                ),
            30,
        ).speak({ text: 'hi', format: 'mp3' });
        const error = await readAll(stream).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).code).toBe('timeout');
    });

    it('aborts the upstream request when the reader cancels', async () => {
        let upstream: AbortSignal | undefined;
        const stream = await client((_input, init) => {
            upstream = init?.signal ?? undefined;
            return Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(new Uint8Array([1]));
                        },
                    }),
                ),
            );
        }).speak({ text: 'hi', format: 'mp3' });
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        expect(upstream?.aborted).toBe(true);
    });

    it('treats an empty audio body as an upstream error', async () => {
        const error = await client(() => Promise.resolve(new Response(new Uint8Array(0))))
            .speak({ text: 'hi', format: 'wav' })
            .catch((e: unknown) => e);
        expect((error as ProviderError).code).toBe('upstream_error');
    });

    it('refuses profiles that are not openai-compatible', () => {
        expect(() =>
            createVoiceClient({
                profile: { ...profile, kind: 'anthropic' },
                getApiKey: () => null,
                redactor: new Redactor(),
            }),
        ).toThrow();
    });

    it('picks the client by params.voiceProtocol and refuses protocols that are not implemented yet', () => {
        const make = (voiceProtocol?: 'openai' | 'openai-chat' | 'volcengine') =>
            createVoiceClient({
                profile: { ...profile, params: voiceProtocol ? { voiceProtocol } : undefined },
                getApiKey: () => null,
                redactor: new Redactor(),
            });
        expect(make()).toHaveProperty('transcribe');
        expect(make('openai')).toHaveProperty('speak');
        expect(() => make('openai-chat')).toThrow('not implemented');
        expect(() => make('volcengine')).toThrow('not implemented');
    });
});

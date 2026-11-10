// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Anthropic / Gemini 原生适配的回放测试(合成 fixture,按官方流式格式手写)。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayFetch, loadFixture } from '@ai-personal/eval';
import { describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import { createProvider } from './registry.js';
import { SecretStore } from './secrets.js';
import { type ChatChunk, type ChatMessage, ProviderError, type ProviderProfile, type ToolSpec } from './types.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const replay = (name: string) => createReplayFetch(loadFixture(join(FIXTURES, `${name}.json`)));
const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';

function make(kind: 'anthropic' | 'gemini', fetchImpl: typeof fetch, model: string) {
    const redactor = new Redactor();
    const secrets = new SecretStore({ dataDir: tmpdir(), redactor, env: { TEST_KEY: FAKE_KEY } });
    const profile: ProviderProfile = {
        id: '01JC0000000000000000000000',
        kind,
        apiKeyRef: 'env:TEST_KEY',
        model,
        purpose: ['chat'],
        params: { temperature: 1.5, maxOutputTokens: 256 },
    };
    return createProvider(profile, { secrets, redactor, fetch: fetchImpl, sleep: () => Promise.resolve() });
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const c of stream) out.push(c);
    return out;
}

const text = (chunks: ChatChunk[]) => chunks.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('');

const tools: ToolSpec[] = [
    {
        name: 'memory.save',
        description: 'Save a memory',
        parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' }, entityKey: { type: ['string', 'null'] } },
            required: ['text'],
        },
    },
];

/** 第二轮:带上一轮的工具调用与结果,检查消息格式的转换。 */
const history: ChatMessage[] = [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: '记住我住杭州' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'm1', name: 'memory.save', input: { text: '住杭州' } }] },
    { role: 'tool', toolCallId: 'm1', content: '{"saved":true}' },
    { role: 'user', content: '再记一条' },
];

describe('Anthropic 原生适配(回放)', () => {
    it('流式文本 + 工具调用;请求为 Messages API 格式,密钥只在 x-api-key 头中', async () => {
        const r = replay('anthropic-tool-call-stream');
        const chunks = await collect(make('anthropic', r.fetch, 'claude-test').stream({ messages: history, tools }));

        expect(text(chunks)).toBe('好的,我来记下。');
        expect(chunks.filter((c) => c.type === 'tool-call')).toEqual([
            { type: 'tool-call', callId: 'toolu_01', name: 'memory.save', input: { text: '用户常住杭州' } },
        ]);
        expect(chunks.at(-1)).toEqual({
            type: 'finish',
            reason: 'tool-calls',
            usage: { inputTokens: 120, outputTokens: 42, totalTokens: 162 },
        });

        const call = r.calls[0]!;
        expect(call.headers.get('x-api-key')).toBe(FAKE_KEY);
        expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
        expect(call.headers.get('authorization')).toBeNull();
        expect(call.body).toEqual({
            model: 'claude-test',
            max_tokens: 256,
            stream: true,
            temperature: 1,
            system: '你是助手。',
            messages: [
                { role: 'user', content: [{ type: 'text', text: '记住我住杭州' }] },
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'm1', name: 'memory__save', input: { text: '住杭州' } }],
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'm1', content: '{"saved":true}' },
                        { type: 'text', text: '再记一条' },
                    ],
                },
            ],
            tools: [{ name: 'memory__save', description: 'Save a memory', input_schema: tools[0]!.parameters }],
        });
    });

    it('流中的 error 事件抛出 upstream_error', async () => {
        const r = replay('anthropic-overloaded-stream');
        const error = await collect(
            make('anthropic', r.fetch, 'claude-test').stream({ messages: [{ role: 'user', content: 'hi' }] }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ code: 'upstream_error', message: expect.stringMatching(/Overloaded/) as string });
    });

    it('连接测试列出模型;无效密钥归为 auth_failed', async () => {
        const r = replay('anthropic-models');
        const p = make('anthropic', r.fetch, 'claude-test');
        expect(await p.test()).toMatchObject({ ok: true, models: ['claude-test'] });
        expect(await p.test()).toMatchObject({ ok: false, error: 'auth_failed' });
    });
});

describe('Gemini 原生适配(回放)', () => {
    it('流式文本 + 函数调用;跳过 thought;请求为 generateContent 格式,密钥不出现在 URL 中', async () => {
        const r = replay('gemini-tool-call-stream');
        const chunks = await collect(make('gemini', r.fetch, 'gemini-test').stream({ messages: history, tools }));

        expect(text(chunks)).toBe('好的,我来记下。');
        expect(chunks.filter((c) => c.type === 'tool-call')).toEqual([
            { type: 'tool-call', callId: 'call_0', name: 'memory.save', input: { text: '用户常住杭州' } },
        ]);
        expect(chunks.at(-1)).toEqual({
            type: 'finish',
            reason: 'tool-calls',
            usage: { inputTokens: 98, outputTokens: 17, totalTokens: 115 },
        });

        const call = r.calls[0]!;
        expect(call.path).not.toContain(FAKE_KEY);
        expect(call.headers.get('x-goog-api-key')).toBe(FAKE_KEY);
        expect(call.body).toEqual({
            systemInstruction: { parts: [{ text: '你是助手。' }] },
            generationConfig: { temperature: 1.5, maxOutputTokens: 256 },
            contents: [
                { role: 'user', parts: [{ text: '记住我住杭州' }] },
                { role: 'model', parts: [{ functionCall: { name: 'memory__save', args: { text: '住杭州' } } }] },
                {
                    role: 'user',
                    parts: [
                        { functionResponse: { name: 'memory__save', response: { result: { saved: true } } } },
                        { text: '再记一条' },
                    ],
                },
            ],
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: 'memory__save',
                            description: 'Save a memory',
                            parameters: {
                                type: 'OBJECT',
                                properties: { text: { type: 'STRING' }, entityKey: { type: 'STRING', nullable: true } },
                                required: ['text'],
                            },
                        },
                    ],
                },
            ],
        });
    });

    it('连接测试列出模型;Gemini 对无效密钥返回的 400 归为 auth_failed', async () => {
        const r = replay('gemini-models');
        const p = make('gemini', r.fetch, 'models/gemini-test');
        expect(await p.test()).toMatchObject({ ok: true, models: ['gemini-test'] });
        expect(await p.test()).toMatchObject({ ok: false, error: 'auth_failed' });
    });
});

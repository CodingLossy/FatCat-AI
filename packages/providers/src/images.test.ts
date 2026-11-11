// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 多段内容(ADR 0020 第 1.1 节):三种适配器把图片映射成各自的格式;没有图片时请求体与 M3 相同。
// 响应沿用已有的合成 fixture,这里只检查请求体;图片是 1×1 的合成 PNG,不是真实照片。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayFetch, loadFixture } from '@fatcat-ai/eval';
import { describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import { createProvider } from './registry.js';
import { SecretStore } from './secrets.js';
import { type ChatMessage, contentParts, plainText, type ProviderProfile } from './types.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const replay = (name: string) => createReplayFetch(loadFixture(join(FIXTURES, `${name}.json`)));
/** 1×1 透明 PNG。 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const withImage: ChatMessage[] = [
    {
        role: 'user',
        content: [
            { type: 'text', text: '图里是什么?' },
            { type: 'image', mediaType: 'image/png', data: PNG },
        ],
    },
];

function make(kind: ProviderProfile['kind'], fetchImpl: typeof fetch) {
    const redactor = new Redactor();
    const secrets = new SecretStore({ dataDir: tmpdir(), redactor, env: { TEST_KEY: 'sk-test-NOT-REAL-0000' } });
    const profile: ProviderProfile = {
        id: '01JC0000000000000000000000',
        kind,
        ...(kind === 'openai-compatible' ? { baseURL: 'http://fixture.test/v1' } : {}),
        apiKeyRef: 'env:TEST_KEY',
        model: kind === 'gemini' ? 'gemini-test' : 'vision-test',
        purpose: ['chat'],
    };
    return createProvider(profile, { secrets, redactor, fetch: fetchImpl, sleep: () => Promise.resolve() });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) void _;
}

const bodyOf = (r: ReturnType<typeof replay>) => r.calls[0]!.body as { messages?: unknown[]; contents?: unknown[] };

describe('多段内容的映射', () => {
    it('OpenAI 兼容:图片为 image_url 的 data URL;纯文本仍发字符串', async () => {
        const r = replay('openai-stream');
        await drain(make('openai-compatible', r.fetch).stream({ messages: withImage }));
        expect(bodyOf(r).messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '图里是什么?' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
                ],
            },
        ]);

        const plain = replay('openai-stream');
        const parts: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
        await drain(make('openai-compatible', plain.fetch).stream({ messages: parts }));
        expect(bodyOf(plain).messages).toEqual([{ role: 'user', content: '你好' }]);
    });

    it('Anthropic:图片为 base64 的 image 块', async () => {
        const r = replay('anthropic-tool-call-stream');
        await drain(make('anthropic', r.fetch).stream({ messages: withImage }));
        expect(bodyOf(r).messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '图里是什么?' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
                ],
            },
        ]);
    });

    it('Gemini:图片为 inlineData', async () => {
        const r = replay('gemini-tool-call-stream');
        await drain(make('gemini', r.fetch).stream({ messages: withImage }));
        expect(bodyOf(r).contents).toEqual([
            { role: 'user', parts: [{ text: '图里是什么?' }, { inlineData: { mimeType: 'image/png', data: PNG } }] },
        ]);
    });

    it('辅助函数:字符串规范成一段文本;plainText 跳过图片', () => {
        expect(contentParts('hi')).toEqual([{ type: 'text', text: 'hi' }]);
        expect(
            plainText([
                { type: 'text', text: 'a' },
                { type: 'image', mediaType: 'image/png', data: PNG },
            ]),
        ).toBe('a');
    });
});

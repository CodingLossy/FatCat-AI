// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DsmlScanner, parseDsmlCalls } from './dsml.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { Redactor } from './redact.js';
import { type ChatChunk, ProviderError } from './types.js';

const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8');

function provider(body: string) {
    return createOpenAICompatibleProvider({
        profile: {
            id: '01JC0000000000000000000000',
            kind: 'openai-compatible',
            baseURL: 'http://fixture.test/v1',
            apiKeyRef: null,
            model: 'deepseek-flash',
            purpose: ['chat'],
        },
        getApiKey: () => null,
        redactor: new Redactor(),
        fetch: () =>
            Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
        sleep: () => Promise.resolve(),
    });
}
const tools = [{ name: 'mail.list', description: 'list', parameters: { type: 'object' } }];
async function collect(it: AsyncIterable<ChatChunk>) {
    const out: ChatChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
}
const textOf = (chunks: ChatChunk[]) => chunks.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('');

describe('DeepSeek DSML 文本工具调用', () => {
    it('解析成真正的工具调用,标记不出现在正文里', async () => {
        const chunks = await collect(
            provider(fixture('deepseek-dsml-calls.sse')).stream({ messages: [{ role: 'user', content: 'x' }], tools }),
        );
        expect(textOf(chunks)).toBe('我先看看邮件。\n\n');
        expect(textOf(chunks)).not.toContain('DSML');
        const call = chunks.find((c) => c.type === 'tool-call');
        expect(call).toMatchObject({ type: 'tool-call', name: 'mail.list', input: { limit: 5, folder: 'INBOX' } });
    });

    it('标记不完整时报 malformed_tool_call,不当正文', async () => {
        const run = collect(
            provider(fixture('deepseek-dsml-truncated.sse')).stream({
                messages: [{ role: 'user', content: 'x' }],
                tools,
            }),
        );
        await expect(run).rejects.toMatchObject({ code: 'malformed_tool_call' });
        await expect(run).rejects.toBeInstanceOf(ProviderError);
    });

    it('没有提供工具时出现标记也算错误', async () => {
        const run = collect(
            provider(fixture('deepseek-dsml-calls.sse')).stream({ messages: [{ role: 'user', content: 'x' }] }),
        );
        await expect(run).rejects.toMatchObject({ code: 'malformed_tool_call' });
    });

    it('扫描器:普通的小于号与被切断的前缀不丢字', () => {
        const scanner = new DsmlScanner();
        const out = [scanner.push('a < b'), scanner.push(' and <'), scanner.push('|')].join('');
        const rest = scanner.end();
        expect(out + rest.text).toBe('a < b and <|');
        expect(rest.markup).toBe('');
    });

    it('解析器:JSON 参数变体与半角竖线', () => {
        const markup =
            '<|DSML|function_calls><|DSML|invoke name="kb__search">{"query":"猫"}</|DSML|invoke></|DSML|function_calls>';
        expect(parseDsmlCalls(markup)).toEqual([{ name: 'kb__search', input: { query: '猫' } }]);
    });
});

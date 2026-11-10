// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 对真实的 OpenAI 兼容端点录制 fixture(计划第 11 节「LLM 录制回放」)。
// 用法(先 pnpm build):
//   FATCAT_AI_EVAL_BASE_URL=https://api.deepseek.com/v1 FATCAT_AI_EVAL_MODEL=deepseek-chat FATCAT_AI_EVAL_KEY_ENV=DEEPSEEK_API_KEY \
//   FATCAT_AI_EVAL_PREFIX=deepseek node packages/providers/scripts/record-fixtures.mjs
// 密钥只从环境变量读取;fixture 不含请求头,落盘前整体脱敏;本脚本只打印摘要,从不打印密钥或响应正文。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordingFetch } from '@fatcat-ai/eval';
import { createProvider, Redactor, SecretStore } from '../dist/index.js';

const baseURL = process.env.FATCAT_AI_EVAL_BASE_URL;
const model = process.env.FATCAT_AI_EVAL_MODEL;
const keyEnv = process.env.FATCAT_AI_EVAL_KEY_ENV;
const prefix = process.env.FATCAT_AI_EVAL_PREFIX ?? 'recorded';
if (!baseURL || !model || !keyEnv) {
    console.error('FATCAT_AI_EVAL_BASE_URL, FATCAT_AI_EVAL_MODEL and FATCAT_AI_EVAL_KEY_ENV are required');
    process.exit(2);
}
if (!process.env[keyEnv]) {
    console.error(`environment variable ${keyEnv} is not set`);
    process.exit(2);
}

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const INVALID_KEY_ENV = 'FATCAT_AI_EVAL_INVALID_KEY';
process.env[INVALID_KEY_ENV] = 'sk-invalid-fixture-key-000000000000';

const redactor = new Redactor();
redactor.add(process.env[keyEnv]);
redactor.add(process.env[INVALID_KEY_ENV]);
const secrets = new SecretStore({ dataDir: tmpdir(), redactor });

const profile = (apiKeyRef) => ({
    id: '01JC0000000000000000000000',
    kind: 'openai-compatible',
    baseURL,
    apiKeyRef,
    model,
    purpose: ['chat'],
    params: { temperature: 0 },
});

async function record(name, apiKeyRef, run) {
    const rec = createRecordingFetch({ name, redact: (t) => redactor.redact(t) });
    const provider = createProvider(profile(apiKeyRef), { secrets, redactor, fetch: rec.fetch });
    let summary;
    try {
        summary = await run(provider);
    } catch (error) {
        summary = { error: error.code ?? 'unknown', status: error.status ?? null };
    }
    rec.save(join(FIXTURES, `${name}.json`));
    console.log(`${name}: ${JSON.stringify(summary)}`);
}

async function collect(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const text = chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join('');
    const finish = chunks.at(-1);
    return {
        textDeltas: chunks.filter((c) => c.type === 'text-delta').length,
        textLength: text.length,
        toolCalls: chunks.filter((c) => c.type === 'tool-call').map((c) => c.name),
        finish: finish?.reason,
        usage: finish?.usage ? Object.keys(finish.usage) : null,
    };
}

await record(`${prefix}-models`, `env:${keyEnv}`, async (p) => {
    const r = await p.test();
    return r.ok ? { ok: true, models: r.models?.length ?? 0 } : { ok: false, error: r.error };
});

await record(`${prefix}-chat-stream`, `env:${keyEnv}`, (p) =>
    collect(
        p.stream({
            messages: [
                { role: 'system', content: 'You produce short test fixtures.' },
                { role: 'user', content: '请只回复四个字:你好世界' },
            ],
        }),
    ),
);

await record(`${prefix}-tool-call-stream`, `env:${keyEnv}`, (p) =>
    collect(
        p.stream({
            messages: [
                { role: 'system', content: 'When the user states a personal fact, call memory.save with that fact.' },
                { role: 'user', content: 'Please remember: I live in Hangzhou.' },
            ],
            tools: [
                {
                    name: 'memory.save',
                    description: 'Save one short fact about the user to long-term memory.',
                    parameters: {
                        type: 'object',
                        properties: { text: { type: 'string', description: 'The fact, one sentence.' } },
                        required: ['text'],
                    },
                },
            ],
        }),
    ),
);

await record(`${prefix}-auth-error`, `env:${INVALID_KEY_ENV}`, (p) =>
    collect(p.stream({ messages: [{ role: 'user', content: 'hi' }] })),
);

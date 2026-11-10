// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayFetch, loadFixture } from '@fatcat-ai/eval';
import { ModelProfile, ModelTestResult, ProblemDetails } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';
const FIXTURES = fileURLToPath(new URL('../../../packages/providers/test/fixtures/', import.meta.url));

let s: TestServer;
afterEach(() => s?.cleanup());

const base = {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseURL: 'http://fixture.test/v1',
    apiKeyRef: 'env:DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    purpose: ['chat'],
};

async function setup(options: Parameters<typeof createTestServer>[1] = {}) {
    s = await createTestServer({}, options);
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf };
    const call = (path: string, init: RequestInit = {}) =>
        s.app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    const post = (path: string, body: unknown, method = 'POST') =>
        call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { call, post };
}

describe('/api/v1/models', () => {
    it('增删改查;keyStatus 反映引用的密钥是否存在,但从不返回密钥值', async () => {
        const { call, post } = await setup({ env: { DEEPSEEK_API_KEY: FAKE_KEY } });
        const created = await post('/api/v1/models', base);
        expect(created.status).toBe(201);
        const profile = ModelProfile.parse(await created.json());
        expect(profile.keyStatus).toBe('present');

        const missing = ModelProfile.parse(
            await (await post('/api/v1/models', { ...base, label: 'Other', apiKeyRef: 'env:NOT_SET' })).json(),
        );
        expect(missing.keyStatus).toBe('missing');

        const list = await call('/api/v1/models');
        const listText = await list.text();
        expect(JSON.parse(listText).items).toHaveLength(2);
        expect(listText).not.toContain(FAKE_KEY);

        const patched = await post(`/api/v1/models/${profile.id}`, { apiKeyRef: null, label: 'Local' }, 'PATCH');
        expect(patched.status).toBe(200);
        expect(ModelProfile.parse(await patched.json())).toMatchObject({ label: 'Local', keyStatus: 'not_required' });

        expect((await call(`/api/v1/models/${profile.id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await call(`/api/v1/models/${profile.id}`)).status).toBe(404);
    });

    it('拒绝明文密钥、非法引用与缺少 baseURL 的配置档', async () => {
        const { post } = await setup();
        const cases = [
            { ...base, apiKey: FAKE_KEY },
            { ...base, apiKeyRef: FAKE_KEY },
            { ...base, apiKeyRef: 'vault:x' },
            { ...base, baseURL: undefined },
            { ...base, baseURL: 'file:///etc/passwd' },
        ];
        for (const body of cases) {
            const res = await post('/api/v1/models', body);
            expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
            expect(ProblemDetails.parse(await res.json()).code).toBe('validation_failed');
        }
        const created = ModelProfile.parse(await (await post('/api/v1/models', base)).json());
        const res = await post(`/api/v1/models/${created.id}`, { apiKey: FAKE_KEY }, 'PATCH');
        expect(res.status).toBe(400);
    });

    it('支持 file: 引用 secrets.yaml', async () => {
        const { post } = await setup();
        writeFileSync(join(s.dir, 'secrets.yaml'), `deepseek: "${FAKE_KEY}"\n`);
        const p = ModelProfile.parse(
            await (await post('/api/v1/models', { ...base, apiKeyRef: 'file:deepseek' })).json(),
        );
        expect(p.keyStatus).toBe('present');
    });
});

describe('POST /api/v1/models/{id}/test', () => {
    it('回放 /models,返回可用模型列表', async () => {
        const replay = createReplayFetch(loadFixture(join(FIXTURES, 'models-list.json')));
        const { post } = await setup({ fetch: replay.fetch, env: { DEEPSEEK_API_KEY: FAKE_KEY } });
        const p = ModelProfile.parse(await (await post('/api/v1/models', base)).json());
        const res = await post(`/api/v1/models/${p.id}/test`, {});
        expect(res.status).toBe(200);
        expect(ModelTestResult.parse(await res.json())).toMatchObject({
            ok: true,
            models: ['qwen3:8b', 'llama3.2:3b'],
        });
        expect(replay.calls[0]!.headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    });

    it('上游拒绝并回显密钥时:结果、日志中都没有密钥', async () => {
        const echo: typeof fetch = () =>
            Promise.resolve(new Response(`{"error":"invalid key ${FAKE_KEY}"}`, { status: 401 }));
        const { post } = await setup({ fetch: echo, env: { DEEPSEEK_API_KEY: FAKE_KEY } });
        const p = ModelProfile.parse(await (await post('/api/v1/models', base)).json());
        const res = await post(`/api/v1/models/${p.id}/test`, {});
        const text = await res.text();
        expect(ModelTestResult.parse(JSON.parse(text))).toMatchObject({ ok: false, error: 'auth_failed' });
        expect(text).not.toContain(FAKE_KEY);
        expect(s.logs.join('')).not.toContain(FAKE_KEY);
    });

    it('引用的密钥不存在时返回 key_missing,不发请求', async () => {
        let called = false;
        const spy: typeof fetch = () => {
            called = true;
            return Promise.resolve(new Response('{}'));
        };
        const { post } = await setup({ fetch: spy });
        const p = ModelProfile.parse(await (await post('/api/v1/models', base)).json());
        const result = ModelTestResult.parse(await (await post(`/api/v1/models/${p.id}/test`, {})).json());
        expect(result).toMatchObject({ ok: false, error: 'key_missing' });
        expect(called).toBe(false);
    });
});

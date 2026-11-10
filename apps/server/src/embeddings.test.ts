// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 嵌入队列与向量索引的端到端用例(ADR 0014):没有 embed 配置档时不加载 sqlite-vec;按维度建表;
// 换模型或维度时提示手动重建,重建后检索正常;失败重试与每日上限;重建需要 CSRF。
import { EmbeddingStatus, ModelProfile } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmbeddingService } from './embeddings.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

/** 假的 /embeddings 端点:向量由文本决定,维度可以随时修改;status 非 200 时返回错误。 */
function embeddingEndpoint() {
    const endpoint = { dims: 3, status: 200, calls: 0 };
    const vectorFor = (text: string) =>
        Array.from({ length: endpoint.dims }, (_, i) =>
            text.includes(['apple', 'banana', 'cherry'][i] ?? '#') ? 1 : 0,
        );
    const fetch: typeof globalThis.fetch = (input, init) => {
        endpoint.calls++;
        if (!String(input).endsWith('/embeddings')) return Promise.resolve(new Response('not found', { status: 404 }));
        if (endpoint.status !== 200)
            return Promise.resolve(new Response('{"error":"nope"}', { status: endpoint.status }));
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        const data = body.input.map((text, index) => ({ index, embedding: vectorFor(text) }));
        return Promise.resolve(Response.json({ data, model: 'test-embed' }));
    };
    return { endpoint, fetch };
}

async function setup() {
    const { endpoint, fetch } = embeddingEndpoint();
    s = await createTestServer({}, { fetch });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const send = (method: string, p: string, body?: unknown) =>
        s.app.request(p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const status = async () => EmbeddingStatus.parse(await (await send('GET', '/api/v1/embeddings/status')).json());
    const ownerId = s.repos.owners.getByUsername('owner')!.id;
    const item = (ref: string) =>
        s.repos.items.upsert(ownerId, {
            source: 'test',
            sourceRef: ref,
            kind: 'content',
            type: 'test.leaf',
            title: ref,
            parentId: null,
        });
    const addProfile = async (model = 'embed-a') =>
        ModelProfile.parse(
            await (
                await send('POST', '/api/v1/models', {
                    label: 'embed',
                    kind: 'openai-compatible',
                    baseURL: 'http://fixture.test/v1',
                    apiKeyRef: null,
                    model,
                    purpose: ['embed'],
                })
            ).json(),
        );
    return { endpoint, cookie, send, status, ownerId, item, addProfile };
}

describe('嵌入队列与向量索引', () => {
    it('没有 embed 配置档时不加载 sqlite-vec、不调用上游;配置后按维度建表并可检索', async () => {
        const { endpoint, status, ownerId, item, addProfile } = await setup();
        const apple = item('apple');
        const banana = item('banana');
        s.embeddings.enqueue(ownerId, apple.id, 0, 'an apple a day');
        s.embeddings.enqueue(ownerId, banana.id, 0, 'banana bread');
        await s.embeddings.idle();
        expect(await status()).toMatchObject({ state: 'disabled', queued: 2, embedded: 0, dimensions: null });
        expect(s.repos.embeddings.extensionLoaded).toBe(false);
        expect(endpoint.calls).toBe(0);
        expect(await s.embeddings.search(ownerId, 'apple', 3)).toBeNull();

        await addProfile(); // 新建配置档会触发队列
        await s.embeddings.idle();
        expect(await status()).toMatchObject({
            state: 'ready',
            model: 'embed-a',
            indexModel: 'embed-a',
            dimensions: 3,
            queued: 0,
            embedded: 2,
            today: 2,
        });
        expect(s.repos.embeddings.extensionLoaded).toBe(true);
        const hits = await s.embeddings.search(ownerId, 'apple pie', 1);
        expect(hits?.map((h) => h.itemId)).toEqual([apple.id]);
    });

    it('换模型或维度时提示手动重建,重建前不再嵌入;重建后按新维度重新嵌入,检索正常', async () => {
        const { endpoint, send, status, ownerId, item, addProfile } = await setup();
        const profile = await addProfile();
        const apple = item('apple');
        s.embeddings.enqueue(ownerId, apple.id, 0, 'apple');
        s.embeddings.enqueue(ownerId, item('banana').id, 0, 'banana');
        await s.embeddings.idle();
        expect((await status()).dimensions).toBe(3);

        // 模型名不变,但端点返回的维度变了:下一次嵌入时发现
        endpoint.dims = 2;
        s.embeddings.enqueue(ownerId, item('cherry').id, 0, 'cherry');
        await s.embeddings.idle();
        expect(await status()).toMatchObject({ state: 'rebuild-required', dimensions: 3, queued: 1, embedded: 2 });
        expect(await s.embeddings.search(ownerId, 'apple', 1)).toBeNull();

        // 越权:缺少 CSRF 不能重建
        const noCsrf = await s.app.request('/api/v1/embeddings/rebuild', jsonBody({}, { cookie: await setupCookie() }));
        expect(noCsrf.status).toBe(403);

        const rebuilt = await send('POST', '/api/v1/embeddings/rebuild');
        expect(await rebuilt.json()).toEqual({ requeued: 2 });
        await s.embeddings.idle();
        expect(await status()).toMatchObject({ state: 'ready', dimensions: 2, queued: 0, embedded: 3 });
        expect((await s.embeddings.search(ownerId, 'apple', 1))?.map((h) => h.itemId)).toEqual([apple.id]);

        // 换了模型名:立即提示重建
        await send('PATCH', `/api/v1/models/${profile.id}`, { model: 'embed-b' });
        expect(await status()).toMatchObject({ state: 'rebuild-required', model: 'embed-b', indexModel: 'embed-a' });
    });

    it('上游失败时退避重试并记录脱敏后的错误;到达每日上限后停止', async () => {
        const { endpoint, status, ownerId, item, addProfile } = await setup();
        await addProfile();
        endpoint.status = 500;
        s.embeddings.enqueue(ownerId, item('apple').id, 0, 'apple');
        await s.embeddings.idle();
        const failed = await status();
        expect(failed).toMatchObject({ queued: 1, embedded: 0 });
        expect(failed.lastError).toMatch(/HTTP 500/);

        // 每日上限:另起一个上限为 1 的服务
        endpoint.status = 200;
        const limited = createEmbeddingService({
            repos: s.repos,
            providerFor: () => ({
                profileId: 'p',
                stream: () => {
                    throw new Error('unused');
                },
                test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
                embed: (texts) =>
                    Promise.resolve({ vectors: texts.map(() => Float32Array.from([1, 0, 0])), model: 'x' }),
            }),
            dailyLimit: 1,
        });
        s.repos.embeddings.rebuild(); // 重置退避
        s.repos.embeddings.enqueue(ownerId, item('banana').id, 0, 'banana');
        limited.kick();
        await limited.idle();
        expect(limited.status(ownerId)).toMatchObject({ embedded: 1, queued: 1, today: 1, dailyLimit: 1 });
        limited.stop();
    });
});

/** 另一个只有 Cookie、没有 CSRF 令牌的请求头。 */
async function setupCookie(): Promise<string> {
    const res = await s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    return sessionFrom(res).cookie;
}

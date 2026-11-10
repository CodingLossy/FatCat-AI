// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 对话峰值内存(M2 方案问题 7、PR 15):1 万条记忆时连续对话,进程 RSS 峰值 < 400 MB。
// 在测试进程内测量,包含 vitest 自身的开销,所以结果偏保守;空闲 RSS 由 CI 的容器门禁测量。
import { performance } from 'node:perf_hooks';
import type { ChatChunk, ModelProvider } from '@fatcat-ai/providers';
import { Session } from '@fatcat-ai/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const MEMORIES = 10_000;
const TURNS = 20;
const ANSWER = '好的。'.repeat(400);

let s: TestServer;
afterAll(async () => {
    await s?.cleanup();
});

describe(`对话峰值内存:${MEMORIES} 条记忆`, () => {
    it(`连续 ${TURNS} 轮对话,RSS 峰值 < 400 MB`, async () => {
        const provider: ModelProvider = {
            profileId: 'fake',
            stream: async function* (): AsyncGenerator<ChatChunk> {
                for (let i = 0; i < ANSWER.length; i += 200)
                    yield { type: 'text-delta', delta: ANSWER.slice(i, i + 200) };
                yield { type: 'finish', reason: 'stop' };
            },
            test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
        };
        s = await createTestServer({}, { provider });
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
        const post = (path: string, body: unknown = {}) =>
            s.app.request(path, { method: 'POST', body: JSON.stringify(body), headers });
        await post('/api/v1/models', {
            label: 'fake',
            kind: 'openai-compatible',
            baseURL: 'http://fake.test/v1',
            apiKeyRef: null,
            model: 'm',
            purpose: ['chat'],
        });

        const ownerId = s.repos.owners.ids()[0]!;
        const places = ['杭州', '上海', '北京', '深圳', '成都'];
        s.repos.memories.save(ownerId, {
            text: '用户常住杭州',
            memType: 'semantic',
            subtype: null,
            entityKey: 'user.location.city',
            cardinality: 'single',
            value: null,
            domain: 'life',
            sensitivity: 0,
            confidence: 0.9,
            origin: 'user_explicit',
        });
        for (let i = 0; i < MEMORIES - 1; i++) {
            s.repos.memories.save(ownerId, {
                text: `用户第 ${i} 次在${places[i % 5]}散步`,
                memType: 'episodic',
                subtype: null,
                entityKey: null,
                cardinality: 'multi',
                value: null,
                domain: 'life',
                sensitivity: 0,
                confidence: 0.8,
                origin: 'user_explicit',
            });
        }

        globalThis.gc?.();
        const idle = process.memoryUsage().rss;
        let peak = idle;
        const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
        const start = performance.now();
        const session = Session.parse(await (await post('/api/v1/sessions')).json());
        for (let turn = 0; turn < TURNS; turn++) {
            const reply = await post(`/api/v1/sessions/${session.id}/messages`, {
                text: `我在杭州散步过几次?第 ${turn} 问`,
            });
            await reply.text(); // 读完 SSE 流
        }
        clearInterval(sampler);
        peak = Math.max(peak, process.memoryUsage().rss);
        const mb = (n: number) => (n / 1048576).toFixed(0);
        console.log(
            `[perf] chat with ${MEMORIES} memories: ${TURNS} turns in ${(performance.now() - start).toFixed(0)} ms, ` +
                `RSS before ${mb(idle)} MB, peak ${mb(peak)} MB`,
        );
        expect(peak).toBeLessThan(400 * 1048576);
    }, 300_000);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { fileURLToPath } from 'node:url';
import { createReplayFetch, loadFixture } from '@fatcat-ai/eval';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import {
    EventEnvelope,
    Memory,
    MemoryDigest,
    MemoryFeedbackResult,
    MemoryWriteResult,
    MemoryRetrieveResult,
    MemorySaveResult,
    MemorySearchResult,
    ProblemDetails,
    Session,
} from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const FIXTURES = fileURLToPath(new URL('../../../packages/providers/test/fixtures/', import.meta.url));

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

type Step = (request: ChatRequest) => AsyncGenerator<ChatChunk>;

function scripted() {
    const steps: Step[] = [];
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: (request) => {
            requests.push(request);
            const next = steps.shift();
            if (!next) throw new Error('no scripted step');
            return next(request);
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    return { provider, steps, requests };
}

const callTool = (name: string, input: unknown): Step =>
    async function* () {
        yield { type: 'tool-call', callId: 'c1', name, input };
        yield { type: 'finish', reason: 'tool-calls' };
    };
const answer = (text: string): Step =>
    async function* () {
        yield { type: 'text-delta', delta: text };
        yield { type: 'finish', reason: 'stop' };
    };

async function setup(options: Parameters<typeof createTestServer>[1] = {}) {
    const fake = scripted();
    s = await createTestServer({}, { provider: fake.provider, ...options });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) => s.app.request(path, { ...init, headers });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    const newSession = async () => Session.parse(await (await post('/api/v1/sessions')).json());
    return { fake, req, post, newSession };
}

/** 读 SSE 流,每收到一个事件回调一次;回调可以发起其他请求(例如审批)。 */
async function readSse(res: Response, onEvent: (e: EventEnvelope) => Promise<void> | void): Promise<EventEnvelope[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const out: EventEnvelope[] = [];
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!data) continue;
            const envelope = EventEnvelope.parse(JSON.parse(data));
            out.push(envelope);
            await onEvent(envelope);
        }
    }
    return out;
}

describe('/api/v1/memory', () => {
    it('写入、读取、编辑、撤回、删除;凭据拒存', async () => {
        const { req, post } = await setup();
        const saved = MemorySaveResult.parse(await (await post('/api/v1/memory', { text: '用户常住杭州' })).json());
        expect(saved.outcome).toBe('created');
        const id = saved.id!;

        const refused = MemorySaveResult.parse(
            await (await post('/api/v1/memory', { text: '我的 key 是 sk-proj-abcdefghijklmnop1234' })).json(),
        );
        expect(refused).toEqual({ outcome: 'refused', reason: 'credential' });

        const list = (await (await req('/api/v1/memory')).json()) as { items: Memory[] };
        expect(list.items.map((m) => m.text)).toEqual(['用户常住杭州']);

        const patched = await req(`/api/v1/memory/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ text: '用户常住杭州西湖区', domain: 'life' }),
        });
        expect(Memory.parse(await patched.json())).toMatchObject({ text: '用户常住杭州西湖区', domain: 'life' });
        const bad = await req(`/api/v1/memory/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ text: '密码是 hunter2hunter2' }),
        });
        expect(bad.status).toBe(400);
        expect(ProblemDetails.parse(await bad.json()).code).toBe('validation_failed');

        const found = MemorySearchResult.parse(await (await post('/api/v1/memory/search', { query: '西湖' })).json());
        expect(found.items).toHaveLength(1);

        await req(`/api/v1/memory/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'retracted' }) });
        expect(
            MemorySearchResult.parse(await (await post('/api/v1/memory/search', { query: '西湖' })).json()).items,
        ).toHaveLength(0);

        expect((await req(`/api/v1/memory/${id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await req(`/api/v1/memory/${id}`)).status).toBe(404);
    });
});

describe('memory.save 审批流程(验收:记住我住杭州 → 新会话问我住哪)', () => {
    it('批准后写入记忆;新会话中 memory.search 能找到', async () => {
        const { fake, post, newSession } = await setup();
        const first = await newSession();
        fake.steps.push(callTool('memory.save', { text: '用户常住杭州', entityKey: 'user.location.city' }));
        fake.steps.push(answer('好的,我记住了。'));

        const res = await post(`/api/v1/sessions/${first.id}/messages`, { text: '记住我住杭州' });
        const events = await readSse(res, async (e) => {
            if (e.event.type === 'approval-required') {
                expect(e.event.summary).toBe('Remember: 用户常住杭州');
                const ok = await post(`/api/v1/approvals/${e.event.callId}`, { decision: 'approve' });
                expect(ok.status).toBe(200);
            }
        });
        expect(events.map((e) => e.event.type)).toContain('approval-resolved');
        expect(events.at(-1)!.event.type).toBe('run-finished');
        const result = events.find((e) => e.event.type === 'tool-result')!.event as { output: { outcome: string } };
        expect(result.output.outcome).toBe('created');

        // 新会话:模型调用 memory.search,拿到之前记住的内容
        const second = await newSession();
        fake.steps.push(callTool('memory.search', { query: '杭州' }));
        fake.steps.push(answer('你住在杭州。'));
        const res2 = await post(`/api/v1/sessions/${second.id}/messages`, { text: '我住哪?' });
        const events2 = await readSse(res2, () => undefined);
        const search = events2.find((e) => e.event.type === 'tool-result')!.event as {
            output: { items: { text: string }[] };
        };
        expect(search.output.items.map((i) => i.text)).toEqual(['用户常住杭州']);
        expect(events2.map((e) => e.event.type)).not.toContain('approval-required');
        // 工具结果作为 tool 消息交回模型
        expect(fake.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: 'tool' });
    });

    it('拒绝后不写入;重复审批或未知 callId 返回 409;拒绝时不能带 remember', async () => {
        const { fake, post, req, newSession } = await setup();
        const session = await newSession();
        fake.steps.push(callTool('memory.save', { text: '用户喜欢喝龙井' }));
        fake.steps.push(answer('好的,不记了。'));
        let callId = '';
        await readSse(await post(`/api/v1/sessions/${session.id}/messages`, { text: '记住我喜欢龙井' }), async (e) => {
            if (e.event.type === 'approval-required') {
                callId = e.event.callId;
                // remember 只能在批准时使用:带 remember 的拒绝返回 400,审批仍然待处理
                const remembered = await post(`/api/v1/approvals/${callId}`, {
                    decision: 'reject',
                    remember: { scope: 'always' },
                });
                expect(remembered.status).toBe(400);
                await post(`/api/v1/approvals/${callId}`, { decision: 'reject' });
            }
        });
        expect(((await (await req('/api/v1/memory')).json()) as { items: unknown[] }).items).toEqual([]);
        const again = await post(`/api/v1/approvals/${callId}`, { decision: 'approve' });
        expect(again.status).toBe(409);
        expect(ProblemDetails.parse(await again.json()).code).toBe('approval_not_pending');
    });
});

describe('每轮的记忆上下文(验收 ①:记住我住杭州 → 新会话问我住哪,带可信度说明)', () => {
    it('第一轮注入 digest,之后按用户消息检索;发出 memory-used;/memory/retrieve 与 /memory/digest', async () => {
        const { fake, post, req, newSession } = await setup();
        const saved = MemorySaveResult.parse(
            await (await post('/api/v1/memory', { text: '用户常住杭州', entityKey: 'user.location.city' })).json(),
        );

        const session = await newSession();
        fake.steps.push(answer('你住在杭州。'));
        const events = await readSse(
            await post(`/api/v1/sessions/${session.id}/messages`, { text: '我住哪?' }),
            () => undefined,
        );
        const used = events.find((e) => e.event.type === 'memory-used')!.event as { ids: string[] };
        expect(used.ids).toEqual([saved.id]);
        const system = fake.requests[0]!.messages.filter((m) => m.role === 'system').map((m) => m.content);
        expect(system.some((c) => typeof c === 'string' && c.includes('用户常住杭州(可靠)'))).toBe(true);

        // 第二轮不再注入 digest,按用户消息检索出带可信度说明的记忆块
        fake.steps.push(answer('是的。'));
        await readSse(
            await post(`/api/v1/sessions/${session.id}/messages`, { text: '我还住在杭州吗?' }),
            () => undefined,
        );
        const second = fake.requests[1]!.messages.filter((m) => m.role === 'system').map((m) => String(m.content));
        expect(second.some((c) => c.includes(`[记忆 m:${saved.id} | 事实`) && c.includes('状态:可靠]'))).toBe(true);
        expect(second.some((c) => c.includes('用户常住杭州(可靠)'))).toBe(false);

        const retrieved = MemoryRetrieveResult.parse(
            await (await post('/api/v1/memory/retrieve', { query: '杭州' })).json(),
        );
        expect(retrieved.items.map((i) => [i.id, i.qualifier])).toEqual([[saved.id, 'reliable']]);
        const digest = MemoryDigest.parse(await (await req('/api/v1/memory/digest')).json());
        expect(digest.ids).toEqual([saved.id]);
    });
});

describe('memory.write 的条件预授权(业主决定 4)', () => {
    /** 运行一轮:模型调用一次 memory.write 再回答;返回是否弹出了审批(弹出时直接批准)和工具结果。 */
    async function runWrite(ctx: Awaited<ReturnType<typeof setup>>, input: unknown) {
        const session = await ctx.newSession();
        ctx.fake.steps.push(callTool('memory.write', input), answer('好的'));
        let asked = false;
        const events = await readSse(
            await ctx.post(`/api/v1/sessions/${session.id}/messages`, { text: '记住' }),
            async (e) => {
                if (e.event.type !== 'approval-required') return;
                asked = true;
                await ctx.post(`/api/v1/approvals/${e.event.callId}`, { decision: 'approve' });
            },
        );
        const result = events.find((e) => e.event.type === 'tool-result')!.event as { output: { outcome: string } };
        return { asked, outcome: result.output.outcome };
    }

    it('普通事实直接写入并记为 conditional;敏感、更替画像、打开「每次都要审批」时需要审批', async () => {
        const ctx = await setup({ conditionalApprovals: true });
        expect(await runWrite(ctx, { text: '用户喜欢喝龙井' })).toEqual({ asked: false, outcome: 'created' });
        const audit = (await (await ctx.req('/api/v1/audit?toolName=memory.write&limit=1')).json()) as {
            items: { decision: string }[];
        };
        expect(audit.items[0]?.decision).toBe('conditional');

        // 第一次写单值画像事实:没有旧值可更替,直接写入
        expect(await runWrite(ctx, { text: '用户住在杭州', entityKey: 'user.location.city' })).toEqual({
            asked: false,
            outcome: 'created',
        });
        // 更替已有的画像事实
        expect(await runWrite(ctx, { text: '用户搬到了上海', entityKey: 'user.location.city' })).toEqual({
            asked: true,
            outcome: 'superseded',
        });
        // sensitivity 1(家庭成员、生日)
        expect((await runWrite(ctx, { text: '我妈妈的生日是 5 月 3 日' })).asked).toBe(true);

        await ctx.req('/api/v1/settings', { method: 'PUT', body: JSON.stringify({ memory: { alwaysApprove: true } }) });
        expect(await runWrite(ctx, { text: '用户喜欢爬山' })).toEqual({ asked: true, outcome: 'created' });
    });
});

describe('评测:真实 OpenAI 兼容 provider 回放 memory.save 往返', () => {
    it('工具名映射、审批、工具结果交回模型', async () => {
        const replay = createReplayFetch(loadFixture(`${FIXTURES}memory-save-roundtrip.json`));
        // provider 置空:走 createProvider + 回放 fetch,而不是脚本化 provider
        const { post, req, newSession } = await setup({ fetch: replay.fetch, provider: undefined });
        const session = await newSession();
        const events = await readSse(
            await post(`/api/v1/sessions/${session.id}/messages`, { text: '记住我住杭州' }),
            async (e) => {
                if (e.event.type === 'approval-required') {
                    expect(e.event.summary).toBe('Remember: 用户常住杭州');
                    await post(`/api/v1/approvals/${e.event.callId}`, { decision: 'approve' });
                }
            },
        );
        expect(events.at(-1)!.event.type).toBe('run-finished');
        expect(replay.remaining()).toBe(0);

        const first = replay.calls[0]!.body as { tools: { function: { name: string } }[] };
        expect(first.tools.map((t) => t.function.name)).toEqual([
            'memory__write',
            'memory__save',
            'memory__retrieve',
            'memory__search',
            'memory__digest',
            'memory__feedback',
            'memory__forget',
            'time',
            'calc',
            'web__fetch',
            'fs__list',
            'fs__read',
            'fs__search',
            'fs__write',
            'fs__move',
            'items__roots',
            'items__children',
            'items__get',
            'items__search',
            'items__open',
            'kb__search',
            'mail__list',
            'mail__search',
            'mail__read',
            'mail__summarize',
            'mail__draft',
            'mail__send',
        ]);
        const second = replay.calls[1]!.body as { messages: { role: string; content?: string }[] };
        const toolMessage = second.messages.find((m) => m.role === 'tool');
        expect(toolMessage?.content).toContain('created');

        const list = (await (await req('/api/v1/memory')).json()) as { items: unknown[] };
        expect(list.items.map((m) => Memory.parse(m).text)).toEqual(['用户常住杭州']);
    });
});

describe('越权', () => {
    it('未登录不能读写记忆或审批;缺少 CSRF 令牌的修改请求被拒绝', async () => {
        const { req } = await setup();
        const anon = (path: string, init: RequestInit = {}) => s.app.request(path, init);
        expect((await anon('/api/v1/memory')).status).toBe(401);
        expect((await anon('/api/v1/memory', jsonBody({ text: '用户常住杭州' }))).status).toBe(401);
        expect((await anon('/api/v1/memory/search', jsonBody({ query: '杭州' }))).status).toBe(401);
        expect((await anon('/api/v1/approvals/c1', jsonBody({ decision: 'approve' }))).status).toBe(401);

        // 带会话 Cookie 但不带 X-CSRF-Token
        const login = await s.app.request(
            '/api/v1/auth/login',
            jsonBody({ username: 'owner', password: TEST_PASSWORD }),
        );
        const { cookie } = sessionFrom(login);
        const noCsrf = await s.app.request('/api/v1/approvals/c1', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
        });
        expect(noCsrf.status).toBe(403);
        expect(ProblemDetails.parse(await noCsrf.json()).code).toBe('csrf_failed');
        expect(((await (await req('/api/v1/memory')).json()) as { items: unknown[] }).items).toEqual([]);
    });
});

describe('记忆 API:反馈、出处、历史、冲突、隔离区与忘记(PR 14)', () => {
    it('验收 ⑤:「错误」并填写更正后立即生效;helpful / stale;同一运行只计一次', async () => {
        const { post, req } = await setup();
        const write = async (body: unknown) =>
            MemorySaveResult.parse(await (await post('/api/v1/memory', body)).json());
        const old = await write({ text: '用户常住杭州', entityKey: 'user.location.city' });
        const fb = async (id: string, body: unknown) =>
            MemoryFeedbackResult.parse(await (await post(`/api/v1/memory/${id}/feedback`, body)).json());

        const corrected = await fb(old.id!, { signal: 'wrong', correction: '用户常住上海' });
        expect(corrected.outcome).toBe('corrected');
        const list = (await (await req('/api/v1/memory')).json()) as { items: Memory[] };
        expect(list.items.map((m) => m.text)).toEqual(['用户常住上海']);
        const history = (await (await req(`/api/v1/memory/${corrected.id}/history`)).json()) as { items: Memory[] };
        expect(history.items.map((m) => [m.text, m.status])).toEqual([
            ['用户常住上海', 'active'],
            ['用户常住杭州', 'superseded'],
        ]);

        const tea = await write({ text: '用户喜欢喝龙井' });
        expect((await fb(tea.id!, { signal: 'helpful', runId: tea.id })).outcome).toBe('applied');
        expect((await fb(tea.id!, { signal: 'helpful', runId: tea.id })).outcome).toBe('duplicate');
        expect((await fb(tea.id!, { signal: 'stale' })).outcome).toBe('applied');
        const after = Memory.parse(await (await req(`/api/v1/memory/${tea.id}`)).json());
        expect(after.confidence).toBeCloseTo(0.8); // 0.9 + 0.05 - 0.15
        expect((await post(`/api/v1/memory/01M00000000000000000000000/feedback`, { signal: 'helpful' })).status).toBe(
            404,
        );
    });

    it('验收 ⑦:「忘记」后 FTS 与来源清空,审计中有记录(只记 id);撤销记为 undo', async () => {
        const { post, req } = await setup();
        const saved = MemorySaveResult.parse(
            await (await post('/api/v1/memory', { text: '用户养了一只叫 Mochi 的猫' })).json(),
        );
        expect((await req(`/api/v1/memory/${saved.id}/sources`)).status).toBe(200);
        expect((await req(`/api/v1/memory/${saved.id}`, { method: 'DELETE' })).status).toBe(204);
        const found = MemorySearchResult.parse(await (await post('/api/v1/memory/search', { query: 'Mochi' })).json());
        expect(found.items).toEqual([]);
        expect(s.repos.memories.sources(s.repos.owners.ids()[0]!, saved.id!)).toEqual([]);

        const undone = MemorySaveResult.parse(
            await (await post('/api/v1/memory', { text: '用户今天心情不错' })).json(),
        );
        expect((await req(`/api/v1/memory/${undone.id}?reason=undo`, { method: 'DELETE' })).status).toBe(204);
        const audit = (await (await req('/api/v1/audit?limit=10')).json()) as {
            items: { action: string; summary: string }[];
        };
        const entries = audit.items.filter((a) => a.action === 'memory-undo').map((a) => a.summary);
        expect(entries).toEqual([`Undid memory ${undone.id}`, `Forgot memory ${saved.id}`]);
        expect(JSON.stringify(audit)).not.toContain('Mochi');
    });

    it('冲突列表与处理;隔离区查看与提升;默认视图隐藏「历史版本」', async () => {
        const { post, req } = await setup();
        const ownerId = s.repos.owners.ids()[0]!;
        // 用户明说 + 抽取的矛盾值 → 冲突
        await post('/api/v1/memory', { text: '用户是后端工程师', entityKey: 'user.role' });
        const memory = (await import('@fatcat-ai/memory')).createMemoryService(s.repos);
        memory.write(ownerId, { text: '用户是产品经理', entityKey: 'user.role' }, { origin: 'extracted' });
        const conflicts = (await (await req('/api/v1/memory/conflicts')).json()) as {
            items: { id: string; a: Memory; b: Memory }[];
        };
        expect(conflicts.items).toHaveLength(1);
        const c = conflicts.items[0]!;
        expect((await post(`/api/v1/memory/conflicts/${c.id}/resolve`, { resolution: 'kept_a' })).status).toBe(204);
        expect((await post(`/api/v1/memory/conflicts/${c.id}/resolve`, { resolution: 'kept_a' })).status).toBe(409);
        expect(Memory.parse(await (await req(`/api/v1/memory/${c.a.id}`)).json()).status).toBe('active');
        expect(Memory.parse(await (await req(`/api/v1/memory/${c.b.id}`)).json()).status).toBe('superseded');

        memory.write(
            ownerId,
            { text: '用户下周去北京出差', memType: 'episodic' },
            { origin: 'extracted', proposeOnly: true },
        );
        const q = (await (await req('/api/v1/memory/quarantine')).json()) as {
            items: { id: string; reason: string }[];
        };
        expect(q.items.map((e) => e.reason)).toEqual(['untrusted_source']);
        const promoted = MemoryWriteResult.parse(
            await (await post(`/api/v1/memory/quarantine/${q.items[0]!.id}/promote`)).json(),
        );
        expect(promoted.outcome).toBe('created');
        expect(((await (await req('/api/v1/memory/quarantine')).json()) as { items: unknown[] }).items).toEqual([]);

        // 知识地图:「工作 → 事实」下默认看不到「历史版本」,includeHidden=true 时能看到
        const group = s.repos.items.bySource(ownerId, 'memory', 'memory:work:semantic')!;
        const visible = (await (await req(`/api/v1/items/${group.id}/children`)).json()) as {
            items: { title: string }[];
        };
        expect(visible.items.map((i) => i.title)).toEqual(['用户是后端工程师']);
        const all = (await (await req(`/api/v1/items/${group.id}/children?includeHidden=true`)).json()) as {
            items: { title: string }[];
        };
        expect(all.items.map((i) => i.title)).toContain('历史版本');
        const opened = (await (await req(`/api/v1/items/${c.a.id}/content`)).json()) as { content: string };
        expect(opened.content).toContain('用户是后端工程师');
        expect(opened.content).toContain('更替历史');
    });
});

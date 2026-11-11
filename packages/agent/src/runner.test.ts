// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChatChunk, type ChatRequest, type ModelProvider, ProviderError } from '@fatcat-ai/providers';
import type { EventEnvelope } from '@fatcat-ai/shared';
import { createRepositories, type ModelProfileRecord, openStorage, type Repositories } from '@fatcat-ai/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './bus.js';
import { type MemoryTurnContext, RunConflictError, RunManager } from './runner.js';

type Script = (request: ChatRequest) => AsyncGenerator<ChatChunk>;

let dir: string;
let close: () => void;
let repos: Repositories;
let ownerId: string;
let profile: ModelProfileRecord;
let bus: EventBus;
let script: Script;
let requests: ChatRequest[];
let manager: RunManager;

const fakeProvider: ModelProvider = {
    profileId: 'p',
    stream: (request) => {
        requests.push(request);
        return script(request);
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
};

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fatcat-agent-'));
    const { conn } = await openStorage({ dataDir: dir });
    close = () => conn.close();
    repos = createRepositories(conn);
    ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    profile = repos.modelProfiles.create(ownerId, {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    bus = new EventBus();
    requests = [];
    script = async function* () {
        yield { type: 'text-delta', delta: '你好' };
        yield { type: 'text-delta', delta: ',世界' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
    };
    manager = new RunManager({ repos, bus, providerFor: () => fakeProvider, persistIntervalMs: 0 });
});

afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
});

const types = (envs: EventEnvelope[]) => envs.map((e) => e.event.type);

describe('RunManager', () => {
    it('流式运行:事件顺序、正文落库、用量、会话标题', async () => {
        const session = repos.sessions.create(ownerId);
        const published: EventEnvelope[] = [];
        bus.subscribe(ownerId, (e) => published.push(e));

        const run = manager.start({ ownerId, sessionId: session.id, profile, text: '请问好' });
        await manager.idle();

        const stored = repos.events.listRunAfter(ownerId, run.runId, 0, 100);
        expect(types(stored)).toEqual([
            'run-started',
            'assistant-state',
            'text-delta',
            'text-delta',
            'run-finished',
            'assistant-state',
        ]);
        expect(published.map((e) => e.seq)).toEqual(stored.map((e) => e.seq)); // 先落库后广播,seq 一致

        const answer = repos.messages.get(ownerId, run.assistantMessageId)!;
        expect(answer).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: '你好,世界' }] });
        expect(answer.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
        expect(repos.runs.get(ownerId, run.runId)).toMatchObject({
            status: 'succeeded',
            outputMessageId: run.assistantMessageId,
        });
        expect(repos.sessions.get(ownerId, session.id)?.title).toBe('请问好');
        expect(requests[0]!.messages).toEqual([{ role: 'user', content: '请问好' }]);
    });

    it('memory-used:有降级时即使没用到记忆也发出,带上 omitted;无降级且无记忆时不发(ADR 0017)', async () => {
        const contexts: MemoryTurnContext[] = [
            { messages: [], ids: [], degraded: [{ path: 'vector', reason: 'timeout' }] },
            { messages: [], ids: [] },
            { messages: ['记忆块'], ids: ['m1'], omitted: 3 },
        ];
        const seen: string[] = [];
        manager = new RunManager({
            repos,
            bus,
            providerFor: () => fakeProvider,
            persistIntervalMs: 0,
            memoryContext: (input) => {
                seen.push(input.runId);
                return Promise.resolve(contexts.shift()!);
            },
        });
        const session = repos.sessions.create(ownerId);
        const runs: string[] = [];
        for (const text of ['一', '二', '三']) {
            runs.push(manager.start({ ownerId, sessionId: session.id, profile, text }).runId);
            await manager.idle();
        }
        expect(seen).toEqual(runs);
        const used = runs.map((runId) =>
            repos.events
                .listRunAfter(ownerId, runId, 0, 100)
                .map((e) => e.event)
                .filter((e) => e.type === 'memory-used'),
        );
        expect(used).toEqual([
            [{ type: 'memory-used', runId: runs[0], ids: [], degraded: [{ path: 'vector', reason: 'timeout' }] }],
            [],
            [{ type: 'memory-used', runId: runs[2], ids: ['m1'], omitted: 3 }],
        ]);
    });

    it('上下文包含之前的问答,跳过被重新生成替代的回复', async () => {
        const session = repos.sessions.create(ownerId);
        const first = manager.start({ ownerId, sessionId: session.id, profile, text: '第一问' });
        await manager.idle();
        script = async function* () {
            yield { type: 'text-delta', delta: '新回答' };
            yield { type: 'finish', reason: 'stop' };
        };
        // 重新生成第一问的回答
        manager.start({
            ownerId,
            sessionId: session.id,
            profile,
            inputMessageId: first.userMessageId,
            replacesMessageId: first.assistantMessageId,
        });
        await manager.idle();
        manager.start({ ownerId, sessionId: session.id, profile, text: '第二问' });
        await manager.idle();

        expect(requests[1]!.messages).toEqual([{ role: 'user', content: '第一问' }]);
        expect(requests[2]!.messages).toEqual([
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '新回答' },
            { role: 'user', content: '第二问' },
        ]);
    });

    it('取消:消息与运行都标为 cancelled,保留已生成的部分', async () => {
        script = async function* (request) {
            yield { type: 'text-delta', delta: '部分' };
            await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve()));
            yield { type: 'finish', reason: 'aborted' };
        };
        const session = repos.sessions.create(ownerId);
        const run = manager.start({ ownerId, sessionId: session.id, profile, text: 'x' });
        await new Promise((r) => setTimeout(r, 10));
        expect(manager.cancel(run.runId)).toBe(true);
        await manager.idle();
        expect(manager.cancel(run.runId)).toBe(false);

        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('cancelled');
        expect(repos.messages.get(ownerId, run.assistantMessageId)).toMatchObject({
            status: 'cancelled',
            parts: [{ type: 'text', text: '部分' }],
        });
        const last = repos.events.listRunAfter(ownerId, run.runId, 0, 100).at(-2)!.event;
        expect(last).toEqual({ type: 'run-finished', runId: run.runId, reason: 'cancelled' });
    });

    it('上游错误:运行失败,事件带 providerCode,消息标为 error', async () => {
        script = async function* () {
            yield { type: 'text-delta', delta: '半' };
            throw new ProviderError('rate_limited', 'upstream returned HTTP 429', 429);
        };
        const session = repos.sessions.create(ownerId);
        const run = manager.start({ ownerId, sessionId: session.id, profile, text: 'x' });
        await manager.idle();

        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('failed');
        expect(repos.messages.get(ownerId, run.assistantMessageId)?.status).toBe('error');
        const failed = repos.events.listRunAfter(ownerId, run.runId, 0, 100).find((e) => e.event.type === 'run-failed');
        expect(failed?.event).toMatchObject({
            type: 'run-failed',
            error: { status: 502, code: 'provider_error', providerCode: 'rate_limited', requestId: run.runId },
        });
    });

    it('同一会话同时只能有一个运行', async () => {
        script = async function* (request) {
            await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve()));
            yield { type: 'finish', reason: 'aborted' };
        };
        const session = repos.sessions.create(ownerId);
        const run = manager.start({ ownerId, sessionId: session.id, profile, text: 'a' });
        expect(() => manager.start({ ownerId, sessionId: session.id, profile, text: 'b' })).toThrow(RunConflictError);
        // 冲突时不应留下多余的用户消息
        expect(repos.messages.list(ownerId, session.id, { limit: 10 }).items).toHaveLength(2);
        manager.cancel(run.runId);
        await manager.idle();
    });

    it('启动时把遗留的运行标为失败并补发终止事件', () => {
        const session = repos.sessions.create(ownerId);
        const user = repos.messages.append(ownerId, session.id, {
            role: 'user',
            parts: [{ type: 'text', text: 'x' }],
            status: 'complete',
        });
        const run = repos.runs.create(ownerId, { sessionId: session.id, inputMessageId: user.id });
        const answer = repos.messages.append(ownerId, session.id, {
            role: 'assistant',
            parts: [],
            status: 'streaming',
            runId: run.id,
        });

        expect(manager.recoverInterrupted()).toBe(1);
        expect(repos.runs.get(ownerId, run.id)?.status).toBe('failed');
        expect(repos.messages.get(ownerId, answer.id)?.status).toBe('error');
        expect(types(repos.events.listRunAfter(ownerId, run.id, 0, 10))).toEqual(['run-failed']);
        expect(manager.recoverInterrupted()).toBe(0);
    });
});

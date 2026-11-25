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
import {
    createCalcTool,
    createSkillUseTool,
    createToolsEnableTool,
    ToolRegistry,
    type ToolDefinition,
} from '@fatcat-ai/tools';
import {
    DEFAULT_RUN_TOKEN_BUDGET,
    type MemoryTurnContext,
    type RunAgent,
    RunConflictError,
    RunManager,
} from './runner.js';
import type { SkillSource } from './run/common.js';

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

describe('代理的记忆设置(ADR 0042)', () => {
    const agent = (memoryScope: 'shared' | 'none') => {
        const record = repos.agents.create(ownerId, {
            name: `agent-${memoryScope}`,
            systemPrompt: '',
            modelProfileId: null,
            toolSet: ['kb.search'],
            memoryScope,
            maxDepth: 2,
            maxSteps: 5,
            budgetTokens: null,
            budgetSeconds: null,
        });
        return {
            id: record.id,
            name: record.name,
            prompt: '',
            toolSet: record.toolSet,
            memoryScope,
            maxSteps: 5,
            maxDepth: 2,
            budgetTokens: null,
            budgetSeconds: null,
        };
    };

    it('memoryScope 为 none 的代理一轮结束后不触发自动抽取;shared 和没有代理时照常触发', async () => {
        const finished: string[] = [];
        manager = new RunManager({
            repos,
            bus,
            providerFor: () => fakeProvider,
            persistIntervalMs: 0,
            onTurnFinished: (turn) => finished.push(turn.runId),
        });
        const session = repos.sessions.create(ownerId);
        const quiet = manager.start({ ownerId, sessionId: session.id, profile, text: 'a', agent: agent('none') });
        await manager.idle();
        const shared = manager.start({ ownerId, sessionId: session.id, profile, text: 'b', agent: agent('shared') });
        await manager.idle();
        const plain = manager.start({ ownerId, sessionId: session.id, profile, text: 'c' });
        await manager.idle();
        expect(finished).toEqual([shared.runId, plain.runId]);
        expect(finished).not.toContain(quiet.runId);
    });
});

describe('按需工具组与预算停止(ADR 0047)', () => {
    const readTool = (name: string): ToolDefinition => ({
        name,
        description: `${name} does things. More detail here.`,
        parameters: { type: 'object' },
        risk: 'read',
        summarize: () => name,
        execute: () => Promise.resolve({ ok: name }),
    });
    const registry = () =>
        new ToolRegistry().register(
            createToolsEnableTool(),
            createCalcTool(),
            readTool('kb.search'),
            readTool('mail.list'),
            readTool('fs.read'),
            readTool('mcp.notes.add'),
        );
    type Step = { call?: { name: string; input: unknown }; text?: string; tokens?: number };
    const scripted = (steps: Step[]) => {
        const queue = [...steps];
        script = async function* () {
            const step = queue.shift() ?? { text: 'done' };
            if (step.call) yield { type: 'tool-call', callId: 'c1', ...step.call };
            if (step.text) yield { type: 'text-delta', delta: step.text };
            yield {
                type: 'finish',
                reason: step.call ? 'tool-calls' : 'stop',
                ...(step.tokens ? { usage: { totalTokens: step.tokens } } : {}),
            };
        };
    };
    const specNames = (i: number) => (requests[i]!.tools ?? []).map((t) => t.name).sort();
    const results = (runId: string) =>
        repos.events
            .listRunAfter(ownerId, runId, 0, 200)
            .map((e) => e.event)
            .filter((e) => e.type === 'tool-result');
    type TaskInput = { id: string; toolSet?: string[]; channelId?: string; withholdToolPrefixes?: string[] };
    const start = (extra: { agent?: RunAgent; task?: TaskInput } = {}, skills?: SkillSource) => {
        const tools = registry();
        if (skills) tools.register(createSkillUseTool());
        manager = new RunManager({
            repos,
            bus,
            providerFor: () => fakeProvider,
            persistIntervalMs: 0,
            tools,
            ...(skills ? { skills } : {}),
        });
        return manager.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x', ...extra });
    };
    /** 一个覆盖 fs 与 kb.search 的内置 Skill(同 local-files)。 */
    const fileSkill: SkillSource = {
        list: () => [{ id: 'local-files', description: 'files', toolSet: ['fs.', 'kb.search'], source: 'builtin' }],
        instructions: () => '# Local files',
    };
    const kbAgent = (): RunAgent => {
        const record = repos.agents.create(ownerId, {
            name: 'kb-only',
            systemPrompt: '',
            modelProfileId: null,
            toolSet: ['kb.'],
            memoryScope: 'shared',
            maxDepth: 0,
            maxSteps: 5,
            budgetTokens: null,
            budgetSeconds: null,
        });
        return {
            id: record.id,
            name: record.name,
            prompt: '',
            toolSet: record.toolSet,
            memoryScope: 'shared',
            maxSteps: 5,
            maxDepth: 0,
            budgetTokens: null,
            budgetSeconds: null,
        };
    };

    it('第一步只交核心组和 tools.enable;开启 mail 组后下一步出现 mail 工具,其他按需组仍不交', async () => {
        scripted([{ call: { name: 'tools.enable', input: { group: 'mail' } } }, { text: 'ok' }]);
        const run = start();
        await manager.idle();
        expect(specNames(0)).toEqual(['calc', 'kb.search', 'tools.enable']);
        expect(specNames(1)).toEqual(['calc', 'kb.search', 'mail.list', 'tools.enable']);
        expect(results(run.runId)[0]).toMatchObject({
            output: { group: 'mail', tools: [{ name: 'mail.list', description: 'mail.list does things.' }] },
        });
        // 系统提示末尾(时间行之前)有按需组目录
        const system = requests[0]!.messages[0]!.content as string;
        expect(system).toContain(
            'Optional tool groups (turn one on with tools.enable): fs (local files in folders the user allowed), ' +
                'mail (e-mail), mcp.notes (tools from MCP server notes).',
        );
        // 开启不跨运行
        scripted([{ text: 'again' }]);
        manager.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'y' });
        await manager.idle();
        expect(specNames(2)).toEqual(['calc', 'kb.search', 'tools.enable']);
    });

    it('没开启就硬调用按需组的工具:按未知工具处理并审计为拒绝,不执行', async () => {
        scripted([{ call: { name: 'fs.read', input: {} } }, { text: 'ok' }]);
        const run = start();
        await manager.idle();
        expect(results(run.runId)[0]).toMatchObject({
            error: 'unknown tool: fs.read (enable group fs with tools.enable first)',
        });
        expect(repos.audit.list(ownerId, { limit: 10 }).items).toEqual([
            expect.objectContaining({ toolName: 'fs.read', decision: 'denied', outcome: 'not_run' }),
        ]);
    });

    it('不存在的组报错,不改变可用的工具', async () => {
        scripted([{ call: { name: 'tools.enable', input: { group: 'shell' } } }, { text: 'ok' }]);
        const run = start();
        await manager.idle();
        expect(results(run.runId)[0]).toMatchObject({ error: 'unknown tool group: shell' });
        expect(specNames(1)).toEqual(['calc', 'kb.search', 'tools.enable']);
    });

    it('越权:toolSet 只有 kb. 的代理开启不了 fs 组,fs.read 仍然不可用', async () => {
        scripted([
            { call: { name: 'tools.enable', input: { group: 'fs' } } },
            { call: { name: 'fs.read', input: {} } },
            { text: 'ok' },
        ]);
        const run = start({ agent: kbAgent() });
        await manager.idle();
        expect(specNames(0)).toEqual(['kb.search']);
        expect(specNames(1)).toEqual(['kb.search']);
        expect(results(run.runId).map((r) => r.type === 'tool-result' && r.error)).toEqual([
            "unknown tool: tools.enable (not in this agent's tool set)",
            "unknown tool: fs.read (not in this agent's tool set)",
        ]);
    });

    it('越权:任务工具集里有 tools.enable 也开启不了集合外的组;集合点名的工具直接可用', async () => {
        scripted([{ call: { name: 'tools.enable', input: { group: 'fs' } } }, { text: 'ok' }]);
        const run = start({ task: { id: 't1', toolSet: ['tools.enable', 'mail.'] } });
        await manager.idle();
        // 工具集点名的 mail.list 不用开启
        expect(specNames(0)).toEqual(['mail.list', 'tools.enable']);
        expect(results(run.runId)[0]).toMatchObject({
            error: "unknown tool group: fs (not in this task's tool set)",
        });
        expect(specNames(1)).toEqual(['mail.list', 'tools.enable']);
    });

    it('Skill 与任务的 withholdToolPrefixes(ADR 0048 第 6 节):被扣下的工具不算进 Skill 的有效工具集', async () => {
        scripted([
            { call: { name: 'skill.use', input: { id: 'local-files' } } },
            { call: { name: 'fs.read', input: {} } },
            { text: 'ok' },
        ]);
        const run = start({ task: { id: 't1', withholdToolPrefixes: ['fs.'] } }, fileSkill);
        await manager.idle();
        expect(specNames(0)).toContain('skill.use');
        const [used, read] = results(run.runId);
        // 没有授权文件夹的任务:Skill 只开出 kb.search,fs.read 仍按未知工具处理
        expect(used).toMatchObject({ output: { id: 'local-files', tools: ['kb.search'] } });
        expect(specNames(1).filter((n) => n.startsWith('fs.'))).toEqual([]);
        expect(read).toMatchObject({ error: 'unknown tool: fs.read' });
    });

    it('任务的 withholdToolPrefixes 也能扣下 skill.use 本身', async () => {
        scripted([{ call: { name: 'skill.use', input: { id: 'local-files' } } }, { text: 'ok' }]);
        const run = start({ task: { id: 't1', withholdToolPrefixes: ['skill.'] } }, fileSkill);
        await manager.idle();
        expect(specNames(0)).not.toContain('skill.use');
        expect(results(run.runId)[0]).toMatchObject({ error: 'unknown tool: skill.use' });
    });

    it('预算:累计 token 超过默认预算后不再开始下一步,附上说明后正常结束', async () => {
        const per = Math.ceil(DEFAULT_RUN_TOKEN_BUDGET / 2.5); // 第 3 步超过预算
        scripted(
            Array.from({ length: 6 }, () => ({ call: { name: 'calc', input: { expression: '1+1' } }, tokens: per })),
        );
        const run = start();
        await manager.idle();
        expect(requests).toHaveLength(3);
        const events = repos.events.listRunAfter(ownerId, run.runId, 0, 200).map((e) => e.event);
        expect(events.find((e) => e.type === 'run-finished')).toMatchObject({ reason: 'stop' });
        expect(events.some((e) => e.type === 'run-failed')).toBe(false);
        const message = repos.messages.get(ownerId, run.assistantMessageId)!;
        expect(message.status).toBe('complete');
        expect(message.parts.at(-1)).toEqual({ type: 'text', text: expect.stringContaining('token 预算') });
    });

    it('代理运行不受默认预算限制(沿用自己的预算)', async () => {
        const per = DEFAULT_RUN_TOKEN_BUDGET;
        scripted([
            { call: { name: 'kb.search', input: {} }, tokens: per },
            { call: { name: 'kb.search', input: {} }, tokens: per },
            { text: 'done', tokens: per },
        ]);
        start({ agent: kbAgent() });
        await manager.idle();
        expect(requests).toHaveLength(3);
    });
});

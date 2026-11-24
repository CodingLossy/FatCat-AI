// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import type { EventEnvelope, Message } from '@fatcat-ai/shared';
import { createRepositories, type ModelProfileRecord, openStorage, type Repositories } from '@fatcat-ai/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './bus.js';
import { estimateTokens, planContext, SUMMARY_PREFIX } from './context.js';
import { currentTimeLine, MAX_TOOL_STEPS, RunManager, SYSTEM_PROMPT } from './runner.js';
import { createFsTools, ToolRegistry, type ToolDefinition } from '@fatcat-ai/tools';

let dir: string;
let close: () => void;
let repos: Repositories;
let ownerId: string;
let profile: ModelProfileRecord;
let bus: EventBus;
let requests: ChatRequest[];
let steps: ((request: ChatRequest) => AsyncGenerator<ChatChunk>)[];

const provider: ModelProvider = {
    profileId: 'p',
    stream: (request) => {
        requests.push(structuredClone({ ...request, signal: undefined }));
        const next = steps.shift();
        if (!next) throw new Error('no scripted step');
        return next(request);
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
};

const saved: unknown[] = [];
const saveTool: ToolDefinition = {
    name: 'memory.save',
    description: 'save',
    parameters: { type: 'object' },
    risk: 'write',
    summarize: (input) => `Remember: ${(input as { text: string }).text}`,
    execute: (input) => {
        saved.push(input);
        return Promise.resolve({ outcome: 'created' });
    },
};
const searchTool: ToolDefinition = {
    name: 'memory.search',
    description: 'search',
    parameters: { type: 'object' },
    risk: 'read',
    summarize: () => '',
    execute: () => Promise.resolve({ items: [{ text: '用户常住杭州' }] }),
};

const callTool = (name: string, input: unknown) =>
    async function* (): AsyncGenerator<ChatChunk> {
        yield { type: 'tool-call', callId: 'model-call-1', name, input };
        yield { type: 'finish', reason: 'tool-calls' };
    };
const answer = (text: string) =>
    async function* (): AsyncGenerator<ChatChunk> {
        yield { type: 'text-delta', delta: text };
        yield { type: 'finish', reason: 'stop' };
    };

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fatcat-agent-tools-'));
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
        contextWindow: 1024,
    });
    bus = new EventBus();
    requests = [];
    steps = [];
    saved.length = 0;
});

afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
});

function manager(extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) {
    return new RunManager({
        repos,
        bus,
        providerFor: () => provider,
        persistIntervalMs: 0,
        tools: new ToolRegistry().register(saveTool, searchTool),
        ...extra,
    });
}

/** 等到某类事件出现。 */
function waitFor(type: string): Promise<EventEnvelope> {
    return new Promise((resolve) => {
        const off = bus.subscribe(ownerId, (e) => {
            if (e.event.type === type) {
                off();
                resolve(e);
            }
        });
    });
}

const eventTypes = (runId: string) => repos.events.listRunAfter(ownerId, runId, 0, 100).map((e) => e.event.type);

describe('工具与审批', () => {
    it('需要审批的工具:暂停 → 批准 → 执行 → 把结果交回模型继续回答', async () => {
        steps = [callTool('memory.save', { text: '用户常住杭州' }), answer('好的,已记住。')];
        const m = manager();
        const session = repos.sessions.create(ownerId);
        const required = waitFor('approval-required');
        const run = m.start({ ownerId, sessionId: session.id, profile, text: '记住我住杭州' });

        const event = (await required).event as { callId: string; summary: string };
        expect(event.summary).toBe('Remember: 用户常住杭州');
        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('waiting_approval');
        expect(saved).toEqual([]);
        expect(m.resolveApproval('someone-else', event.callId, 'approve')).toBe('not_pending');
        expect(m.resolveApproval(ownerId, event.callId, 'approve')).toBe('resolved');
        expect(m.resolveApproval(ownerId, event.callId, 'approve')).toBe('not_pending');
        await m.idle();

        expect(saved).toEqual([{ text: '用户常住杭州' }]);
        expect(eventTypes(run.runId)).toEqual([
            'run-started',
            'assistant-state',
            'tool-call',
            'approval-required',
            'approval-resolved',
            'assistant-state',
            'tool-result',
            'assistant-state',
            'text-delta',
            'run-finished',
            'assistant-state',
        ]);
        // 第一次请求带系统提示与工具;第二次带上工具调用与结果
        // 系统提示的最后一行是用户时区的当前时间(ADR 0023)
        expect(requests[0]!.messages[0]).toEqual({
            role: 'system',
            content: expect.stringMatching(/^[\s\S]+\n当前时间:\d{4}-\d{2}-\d{2} \d{2}:\d{2}\(/),
        });
        expect(String(requests[0]!.messages[0]!.content).startsWith(`${SYSTEM_PROMPT}\n`)).toBe(true);
        expect(requests[0]!.tools?.map((t) => t.name)).toEqual(['memory.save', 'memory.search']);
        // 审批请求持久化,决定后状态为 approved;write 调用写一行审计
        expect(repos.approvals.get(ownerId, event.callId)).toMatchObject({
            status: 'approved',
            toolName: 'memory.save',
            risk: 'write',
            input: { text: '用户常住杭州' },
        });
        expect(repos.audit.list(ownerId, { limit: 10 }).items).toEqual([
            expect.objectContaining({
                toolName: 'memory.save',
                decision: 'approved',
                outcome: 'ok',
                callId: event.callId,
            }),
        ]);
        expect(requests[1]!.messages.slice(-2)).toEqual([
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ callId: 'model-call-1', name: 'memory.save', input: { text: '用户常住杭州' } }],
            },
            { role: 'tool', toolCallId: 'model-call-1', content: JSON.stringify({ outcome: 'created' }) },
        ]);
        const message = repos.messages.get(ownerId, run.assistantMessageId)!;
        expect(message.status).toBe('complete');
        expect(message.parts.map((p) => p.type)).toEqual(['tool-call', 'tool-result', 'text']);
        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('succeeded');
    });

    it('拒绝时不执行,模型收到拒绝结果', async () => {
        steps = [callTool('memory.save', { text: 'x' }), answer('好的,不保存。')];
        const m = manager();
        const required = waitFor('approval-required');
        const run = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x' });
        m.resolveApproval(ownerId, ((await required).event as { callId: string }).callId, 'reject');
        await m.idle();
        expect(saved).toEqual([]);
        expect(requests[1]!.messages.at(-1)).toEqual({
            role: 'tool',
            toolCallId: 'model-call-1',
            content: JSON.stringify({ error: 'the user rejected this action' }),
        });
        const result = repos.events
            .listRunAfter(ownerId, run.runId, 0, 100)
            .find((e) => e.event.type === 'tool-result')!.event;
        expect(result).toMatchObject({ error: 'the user rejected this action' });
    });

    it('等待审批时取消运行:以 cancelled 结束,不执行工具', async () => {
        steps = [callTool('memory.save', { text: 'x' })];
        const m = manager();
        const required = waitFor('approval-required');
        const run = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x' });
        const { callId } = (await required).event as { callId: string };
        m.cancel(run.runId);
        await m.idle();
        expect(saved).toEqual([]);
        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('cancelled');
        expect(repos.approvals.get(ownerId, callId)?.status).toBe('cancelled');
        expect(repos.audit.list(ownerId, { limit: 10 }).items[0]).toMatchObject({
            decision: 'cancelled',
            outcome: 'not_run',
        });
    });

    it('不需要审批的工具直接执行;未知工具返回错误', async () => {
        steps = [callTool('memory.search', { query: '住' }), callTool('shell.exec', {}), answer('完成')];
        const m = manager();
        const run = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x' });
        await m.idle();
        const results = repos.events
            .listRunAfter(ownerId, run.runId, 0, 100)
            .filter((e) => e.event.type === 'tool-result')
            .map((e) => e.event);
        expect(results[0]).toMatchObject({ output: { items: [{ text: '用户常住杭州' }] } });
        expect(results[1]).toMatchObject({ error: 'unknown tool: shell.exec' });
        expect(eventTypes(run.runId)).not.toContain('approval-required');
        // 普通的 read 调用不审计;未知工具按「拒绝」审计
        expect(repos.audit.list(ownerId, { limit: 10 }).items).toEqual([
            expect.objectContaining({ toolName: 'shell.exec', risk: null, decision: 'denied', outcome: 'not_run' }),
        ]);
    });

    it('超过最大轮数后不再提供工具', async () => {
        steps = Array.from({ length: MAX_TOOL_STEPS }, () => callTool('memory.search', {}));
        steps.push(answer('结束'));
        const m = manager();
        m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x' });
        await m.idle();
        expect(MAX_TOOL_STEPS).toBe(10);
        expect(requests).toHaveLength(MAX_TOOL_STEPS + 1);
        expect(requests[MAX_TOOL_STEPS]!.tools).toBeUndefined();
    });
});

describe('审批策略、预授权与过期(ADR 0010)', () => {
    const toolOf = (over: Partial<ToolDefinition>): ToolDefinition => ({
        name: 'x.tool',
        description: '',
        parameters: { type: 'object' },
        risk: 'write',
        summarize: () => 'do x',
        execute: (input) => {
            saved.push(input);
            return Promise.resolve('done');
        },
        ...over,
    });

    it('批准时记住(本会话):同一会话后续调用直接执行并审计为 preauthorized;其他会话仍需审批', async () => {
        const m = manager({ tools: new ToolRegistry().register(toolOf({})) });
        const session = repos.sessions.create(ownerId);
        steps = [callTool('x.tool', { n: 1 }), answer('ok')];
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: session.id, profile, text: 'a' });
        const event = (await required).event as { callId: string; risk: string; toolName: string; expiresAt: string };
        expect(event).toMatchObject({ toolName: 'x.tool', risk: 'write' });
        expect(Date.parse(event.expiresAt)).toBeGreaterThan(Date.now());
        expect(m.resolveApproval(ownerId, event.callId, 'reject', { scope: 'session' })).toEqual({
            invalid: 'remember is only allowed when approving',
        });
        expect(m.resolveApproval(ownerId, event.callId, 'approve', { scope: 'session' })).toBe('resolved');
        await m.idle();

        steps = [callTool('x.tool', { n: 2 }), answer('ok')];
        const run2 = m.start({ ownerId, sessionId: session.id, profile, text: 'b' });
        await m.idle();
        expect(eventTypes(run2.runId)).not.toContain('approval-required');
        expect(saved).toEqual([{ n: 1 }, { n: 2 }]);
        const audit = repos.audit.list(ownerId, { limit: 10 }).items;
        expect(audit.map((a) => [a.action, a.decision])).toEqual([
            ['tool-call', 'preauthorized'],
            ['tool-call', 'approved'],
            ['preauth-created', null],
        ]);
        expect(repos.preauths.list(ownerId)[0]?.lastUsedAt).not.toBeNull();

        steps = [callTool('x.tool', { n: 3 })];
        const other = waitFor('approval-required');
        const run3 = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'c' });
        await other;
        m.cancel(run3.runId);
        await m.idle();
    });

    it('库里存下的、缺了必填约束的预授权不生效(web.fetch 没有域名等于放行所有网站),带域名的照常生效', async () => {
        const fetchLike = toolOf({
            name: 'x.fetch',
            risk: 'read',
            approval: 'required',
            requireConstraint: 'domain',
            constraints: { domain: (input) => (input as { host: string }).host },
        });
        const m = manager({ tools: new ToolRegistry().register(fetchLike) });
        const session = repos.sessions.create(ownerId);
        repos.preauths.create(ownerId, {
            toolName: 'x.fetch',
            scope: 'always',
            sessionId: session.id,
            constraint: null,
        });
        steps = [callTool('x.fetch', { host: 'bbc.com' })];
        const required = waitFor('approval-required');
        const run1 = m.start({ ownerId, sessionId: session.id, profile, text: 'a' });
        await required;
        m.cancel(run1.runId);
        await m.idle();
        expect(saved).toEqual([]);

        repos.preauths.create(ownerId, {
            toolName: 'x.fetch',
            scope: 'always',
            sessionId: session.id,
            constraint: { domain: 'bbc.com' },
        });
        steps = [callTool('x.fetch', { host: 'bbc.com' }), answer('ok')];
        m.start({ ownerId, sessionId: session.id, profile, text: 'b' });
        await m.idle();
        expect(saved).toEqual([{ host: 'bbc.com' }]);
    });

    it('越权:external 工具不能预授权;dangerous 工具默认被拒绝并审计', async () => {
        const external = toolOf({ name: 'x.send', risk: 'external' });
        const dangerous = toolOf({ name: 'x.shell', risk: 'dangerous' });
        const m = manager({ tools: new ToolRegistry().register(external, dangerous) });
        steps = [callTool('x.shell', {}), callTool('x.send', {}), answer('ok')];
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'a' });
        const { callId } = (await required).event as { callId: string };
        expect(m.resolveApproval(ownerId, callId, 'approve', { scope: 'always' })).toEqual({
            invalid: 'external tools cannot be pre-authorized',
        });
        expect(repos.approvals.get(ownerId, callId)?.status).toBe('pending');
        m.resolveApproval(ownerId, callId, 'reject');
        await m.idle();
        expect(saved).toEqual([]);
        expect(repos.preauths.list(ownerId)).toEqual([]);
        // 被禁用的 dangerous 工具不提供给模型,模型硬调用也被拒绝
        expect(requests[0]!.tools?.map((t) => t.name)).toEqual(['x.send']);
        expect(
            repos.audit
                .list(ownerId, { limit: 10 })
                .items.map((a) => [a.toolName, a.decision, a.outcome])
                .reverse(),
        ).toEqual([
            ['x.shell', 'denied', 'not_run'],
            ['x.send', 'rejected', 'not_run'],
        ]);
    });

    it('审批过期:按拒绝处理,发出 reason=expired 的 approval-resolved', async () => {
        const m = manager({ tools: new ToolRegistry().register(toolOf({})), approvalTimeoutMs: 20 });
        steps = [callTool('x.tool', {}), answer('ok')];
        const resolved = waitFor('approval-resolved');
        const run = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'a' });
        expect((await resolved).event).toMatchObject({ decision: 'reject', reason: 'expired' });
        await m.idle();
        expect(saved).toEqual([]);
        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('succeeded');
        expect(requests[1]!.messages.at(-1)).toMatchObject({
            content: JSON.stringify({ error: 'the approval request expired' }),
        });
        expect(repos.audit.list(ownerId, { limit: 10 }).items[0]).toMatchObject({ decision: 'expired' });
    });

    it('条件预授权成立时直接执行;本次运行见过不可信内容后失效;入参在审批与审计中脱敏', async () => {
        const fetchTool = toolOf({ name: 'x.fetch', risk: 'read', untrustedOutput: true });
        const conditional = toolOf({ name: 'x.remember', autoApproveWhen: () => true });
        const m = manager({
            tools: new ToolRegistry().register(fetchTool, conditional),
            redact: (t) => t.replaceAll('sk-secret', '[REDACTED]'),
        });
        steps = [
            callTool('x.remember', { key: 'sk-secret' }),
            callTool('x.fetch', {}),
            callTool('x.remember', {}),
            answer('ok'),
        ];
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'a' });
        const { callId } = (await required).event as { callId: string };
        m.resolveApproval(ownerId, callId, 'reject');
        await m.idle();
        const audit = repos.audit.list(ownerId, { limit: 10 }).items.reverse();
        expect(audit.map((a) => [a.toolName, a.decision])).toEqual([
            ['x.remember', 'conditional'],
            ['x.remember', 'rejected'],
        ]);
        expect(audit[0]!.inputDigest).toBe('{"key":"[REDACTED]"}');
    });

    it('重启:遗留的 pending 审批请求一律过期,之后不能再批准', async () => {
        const m = manager();
        steps = [callTool('memory.save', { text: 'x' })];
        const required = waitFor('approval-required');
        const run = m.start({ ownerId, sessionId: repos.sessions.create(ownerId).id, profile, text: 'x' });
        const { callId } = (await required).event as { callId: string };
        // 模拟进程退出:新的 RunManager 启动时收尾
        const restarted = manager();
        restarted.recoverInterrupted();
        expect(repos.approvals.get(ownerId, callId)?.status).toBe('expired');
        expect(restarted.resolveApproval(ownerId, callId, 'approve')).toBe('not_pending');
        expect(m.resolveApproval(ownerId, callId, 'approve')).toBe('not_pending');
        m.cancel(run.runId);
        await m.idle();
        expect(saved).toEqual([]);
    });
});

describe('上下文压缩', () => {
    const say = (sessionId: string, role: 'user' | 'assistant', text: string) =>
        repos.messages.append(ownerId, sessionId, { role, parts: [{ type: 'text', text }], status: 'complete' });

    it('超出预算的旧消息压缩成摘要并落库,之后复用', async () => {
        const session = repos.sessions.create(ownerId);
        for (let i = 0; i < 6; i++) {
            say(session.id, 'user', `问题${i} ${'很长的内容'.repeat(30)}`);
            say(session.id, 'assistant', `回答${i} ${'很长的内容'.repeat(30)}`);
        }
        const transcripts: string[] = [];
        const m = manager({
            tools: new ToolRegistry(),
            summarize: (_owner, transcript) => {
                transcripts.push(transcript);
                return Promise.resolve('用户问了六个问题,都已回答。');
            },
        });
        steps = [answer('a')];
        m.start({ ownerId, sessionId: session.id, profile, text: '新问题' });
        await m.idle();

        expect(transcripts).toHaveLength(1);
        expect(transcripts[0]).toContain('User: 问题0');
        const summaries = repos.summaries.list(session.id);
        expect(summaries).toHaveLength(1);
        const sent = requests[0]!.messages;
        expect(sent[0]).toEqual({ role: 'system', content: `${SUMMARY_PREFIX}\n\n用户问了六个问题,都已回答。` });
        expect(sent.at(-1)).toEqual({ role: 'user', content: '新问题' });
        expect(sent.length).toBeLessThan(13);
        // 原文仍在库中
        expect(repos.messages.list(ownerId, session.id, { limit: 50 }).items.length).toBe(14);

        // 第二次运行复用已有摘要,只压缩新增部分
        steps = [answer('b')];
        m.start({ ownerId, sessionId: session.id, profile, text: '再问' });
        await m.idle();
        expect(requests[1]!.messages[0]!.content).toContain('用户问了六个问题');
    });

    it('摘要失败时直接丢弃旧消息,运行照常完成', async () => {
        const session = repos.sessions.create(ownerId);
        for (let i = 0; i < 6; i++) say(session.id, 'user', `${'很长的内容'.repeat(40)}${i}`);
        const errors: unknown[] = [];
        const m = manager({
            tools: new ToolRegistry(),
            summarize: () => Promise.reject(new Error('cheap model down')),
            onError: (e) => errors.push(e),
        });
        steps = [answer('ok')];
        const run = m.start({ ownerId, sessionId: session.id, profile, text: '新问题' });
        await m.idle();
        expect(repos.runs.get(ownerId, run.runId)?.status).toBe('succeeded');
        expect(errors).toHaveLength(1);
        expect(repos.summaries.list(session.id)).toEqual([]);
        expect(requests[0]!.messages.some((x) => x.role === 'system')).toBe(false);
    });
});

describe('预算估算', () => {
    it('中文按字、英文约 4 字符 1 token;至少保留最近 2 条', () => {
        expect(estimateTokens('你好世界')).toBe(4);
        expect(estimateTokens('abcdefgh')).toBe(2);
        const msg = (seq: number, text: string): Message => ({
            id: String(seq),
            sessionId: 's',
            seq,
            role: 'user',
            parts: [{ type: 'text', text }],
            status: 'complete',
            runId: null,
            parentMessageId: null,
            modelProfileId: null,
            usage: null,
            createdAt: '',
            updatedAt: '',
        });
        const plan = planContext([msg(1, '长'.repeat(500)), msg(2, '长'.repeat(500)), msg(3, '短')], 100);
        expect(plan.toCompress.map((m) => m.seq)).toEqual([1]);
        expect(plan.recent.map((m) => m.seq)).toEqual([2, 3]);
    });
});

describe('系统提示中的当前时间(ADR 0023)', () => {
    const at = Date.parse('2026-11-10T17:00:00Z');
    it('按用户时区,只到分钟;没设置时跟随服务器', () => {
        expect(currentTimeLine({ locale: 'zh-CN', timeZone: 'Asia/Shanghai' }, at)).toBe(
            '当前时间:2026-11-11 01:00(Asia/Shanghai,星期三)。',
        );
        expect(currentTimeLine({ locale: 'en', timeZone: 'UTC' }, at)).toBe(
            'Current time: 2026-11-10 17:00 (UTC, Tuesday).',
        );
        const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
        expect(currentTimeLine({ locale: 'en', timeZone: null }, at)).toContain(`(${server},`);
    });
});

describe('审批预览(ADR 0046 第 12 节)', () => {
    const previewTool = (preview: ToolDefinition['preview']): ToolDefinition => ({ ...saveTool, preview });

    it('预览随 approval-required 事件发出,但批准的仍是原入参,执行不受预览影响', async () => {
        steps = [callTool('memory.save', { text: 'real' }), answer('ok')];
        const m = manager({
            tools: new ToolRegistry().register(
                previewTool(() => ({
                    kind: 'diff',
                    path: 'x.txt',
                    state: 'created',
                    text: '+shown',
                    truncated: false,
                })),
            ),
        });
        const session = repos.sessions.create(ownerId);
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: session.id, profile, text: 'go' });
        const event = (await required).event as { callId: string; preview?: { text: string } };
        expect(event.preview?.text).toBe('+shown');
        expect(m.resolveApproval(ownerId, event.callId, 'approve')).toBe('resolved');
        await m.idle();
        expect(saved).toEqual([{ text: 'real' }]);
        // 预览不持久化
        expect(JSON.stringify(repos.approvals.get(ownerId, event.callId))).not.toContain('shown');
    });

    it('预览抛错时审批照常,事件里没有 preview', async () => {
        steps = [callTool('memory.save', { text: 'real' }), answer('ok')];
        const m = manager({
            tools: new ToolRegistry().register(
                previewTool(() => {
                    throw new Error('boom');
                }),
            ),
        });
        const session = repos.sessions.create(ownerId);
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: session.id, profile, text: 'go' });
        const event = (await required).event as { callId: string; preview?: unknown };
        expect(event.preview).toBeUndefined();
        expect(m.resolveApproval(ownerId, event.callId, 'reject')).toBe('resolved');
        await m.idle();
        expect(saved).toEqual([]);
    });

    it('警示抛错时审批照常发出(不带警示,仍然要批准),运行不中断', async () => {
        steps = [callTool('memory.save', { text: 'real' }), answer('ok')];
        const m = manager({
            tools: new ToolRegistry().register({
                ...saveTool,
                warnings: () => {
                    throw new Error('boom');
                },
            }),
        });
        const session = repos.sessions.create(ownerId);
        const required = waitFor('approval-required');
        m.start({ ownerId, sessionId: session.id, profile, text: 'go' });
        const event = (await required).event as { callId: string; warnings?: unknown };
        expect(event.warnings).toBeUndefined();
        expect(m.resolveApproval(ownerId, event.callId, 'approve')).toBe('resolved');
        await m.idle();
        expect(saved).toEqual([{ text: 'real' }]);
    });
});

// Windows 没有 mkfifo(命名管道的语义与 POSIX FIFO 不同),这一组只在 POSIX 上跑;
// Windows 的命名管道 \\.\pipe\… 在 packages/tools/src/fs/preview.test.ts 里测(CI 的 Windows 任务会跑)
describe.skipIf(process.platform === 'win32')('🔒 fs.write 指向 FIFO(ADR 0046 第 12 节)', () => {
    it('审批照常出现(没有 preview,也不会卡住);批准后执行被拒绝,运行正常结束', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-fifo-')));
        try {
            const fifo = join(root, 'pipe');
            execFileSync('mkfifo', [fifo]);
            steps = [callTool('fs.write', { path: fifo, content: 'x', overwrite: true }), answer('ok')];
            const m = manager({ tools: new ToolRegistry().register(...createFsTools({ roots: () => [root] })) });
            const session = repos.sessions.create(ownerId);
            const required = waitFor('approval-required');
            m.start({ ownerId, sessionId: session.id, profile, text: 'go' });
            const event = (await required).event as { callId: string; toolName: string; preview?: unknown };
            expect(event.toolName).toBe('fs.write');
            expect(event.preview).toBeUndefined();
            expect(m.resolveApproval(ownerId, event.callId, 'approve')).toBe('resolved');
            await m.idle();
            const audit = repos.audit.list(ownerId, { limit: 10 }).items.filter((a) => a.toolName === 'fs.write');
            expect(audit).toEqual([
                expect.objectContaining({ outcome: 'not_run', error: expect.stringContaining('not a regular file') }),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

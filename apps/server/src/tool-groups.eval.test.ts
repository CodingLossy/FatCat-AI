// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 按需工具组评测(ADR 0047 第 1 节):第一步只交核心组;模型先用 tools.enable 开启 fs 组再读文件;
// 开启不改变审批:写文件的审批卡照常出现,拒绝后不写入;没开启就硬调用按未知工具处理。
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { AuditEntry, EventEnvelope, pageOf, Session } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
let base: string;
beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-tool-groups-')));
    writeFileSync(path.join(base, 'notes.md'), '第一行:买猫粮\n第二行:写周报');
});
afterEach(async () => {
    await s?.cleanup();
    rmSync(base, { recursive: true, force: true });
});

type Step = (request: ChatRequest) => AsyncGenerator<ChatChunk>;
const call = (callId: string, name: string, input: unknown): Step =>
    async function* () {
        yield { type: 'tool-call', callId, name, input };
        yield { type: 'finish', reason: 'tool-calls' };
    };
const answer = (text: string): Step =>
    async function* () {
        yield { type: 'text-delta', delta: text };
        yield { type: 'finish', reason: 'stop' };
    };

async function setup() {
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
    s = await createTestServer({}, { provider });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (p: string, init: RequestInit = {}) => s.app.request(p, { ...init, headers });
    const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body) });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    expect((await post('/api/v1/fs/roots', { path: base, label: '笔记' })).status).toBe(201);
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    /** 发一条消息并跑完这一轮;审批一律拒绝。 */
    const run = async (text: string) => {
        const out = await post(`/api/v1/sessions/${session.id}/messages`, { text });
        const reader = out.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const events: EventEnvelope['event'][] = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const data = /^data: (.*)$/m.exec(buffer.slice(0, idx))?.[1];
                buffer = buffer.slice(idx + 2);
                if (!data) continue;
                const e = EventEnvelope.parse(JSON.parse(data)).event;
                events.push(e);
                if (e.type === 'approval-required') await post(`/api/v1/approvals/${e.callId}`, { decision: 'reject' });
            }
        }
        return events;
    };
    const audit = async () => pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json()).items;
    return { steps, requests, run, audit };
}

const names = (request: ChatRequest) => (request.tools ?? []).map((t) => t.name);

describe('按需工具组评测', () => {
    it('「读一下授权目录里的 notes.md」:先开 fs 组再读;写文件的审批卡照常出现,拒绝后不写入', async () => {
        const { steps, requests, run, audit } = await setup();
        const notes = path.join(base, 'notes.md');
        const copy = path.join(base, 'copy.md');
        steps.push(
            call('m1', 'tools.enable', { group: 'fs' }),
            call('m2', 'fs.read', { path: notes }),
            call('m3', 'fs.write', { path: copy, content: '第一行:买猫粮' }),
            answer('第一行是「买猫粮」。'),
        );
        const events = await run('读一下授权目录里的 notes.md');

        // 第一步只有核心组和 tools.enable,系统提示里有按需组目录
        expect(names(requests[0]!)).toContain('tools.enable');
        expect(names(requests[0]!).some((n) => n.startsWith('fs.'))).toBe(false);
        expect(requests[0]!.messages[0]!.content).toContain('Optional tool groups (turn one on with tools.enable): ');
        expect(requests[0]!.messages[0]!.content).toContain('fs (local files in folders the user allowed)');
        // 开启后下一步交出 fs 组
        expect(names(requests[1]!)).toEqual(expect.arrayContaining(['fs.read', 'fs.write', 'fs.list']));

        const results = events.filter((e) => e.type === 'tool-result');
        expect(results[0]).toMatchObject({ output: { group: 'fs' } });
        expect(JSON.stringify(results[1])).toContain('买猫粮');
        // 写文件仍然要审批;拒绝后不写入
        const approvals = events.filter((e) => e.type === 'approval-required');
        expect(approvals.map((a) => a.toolName)).toEqual(['fs.write']);
        expect(results[2]).toMatchObject({ error: 'the user rejected this action' });
        expect(existsSync(copy)).toBe(false);
        expect(readFileSync(notes, 'utf8')).toContain('买猫粮');
        // tools.enable 与普通的读不审计;写入的拒绝照常审计
        expect((await audit()).map((a) => [a.toolName, a.decision])).toEqual([['fs.write', 'rejected']]);
    });

    it('没开启就硬调用 fs.read:按未知工具处理,审计为拒绝,不读文件', async () => {
        const { steps, run, audit } = await setup();
        steps.push(call('m1', 'fs.read', { path: path.join(base, 'notes.md') }), answer('读不到。'));
        const events = await run('读一下 notes.md');
        const result = events.find((e) => e.type === 'tool-result');
        expect(result).toMatchObject({ error: 'unknown tool: fs.read (enable group fs with tools.enable first)' });
        expect(JSON.stringify(result)).not.toContain('买猫粮');
        expect((await audit()).map((a) => [a.toolName, a.decision, a.outcome])).toEqual([
            ['fs.read', 'denied', 'not_run'],
        ]);
    });
});

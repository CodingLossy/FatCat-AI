// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 授权目录 REST 与文件工具的端到端用例(ADR 0011):越权路径被拒绝并审计;按目录预授权;撤销目录时删除预授权。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { AuditEntry, EventEnvelope, FsRoot, pageOf, Preauthorization, Session } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
let base: string;
beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-fs-api-')));
    mkdirSync(path.join(base, 'Docs', 'notes'), { recursive: true });
    mkdirSync(path.join(base, 'Private'));
    writeFileSync(path.join(base, 'Docs', 'report.md'), '# 周报\n本周完成了 M2。');
    writeFileSync(path.join(base, 'Private', 'secret.txt'), 'top secret');
});
afterEach(async () => {
    await s?.cleanup();
    rmSync(base, { recursive: true, force: true });
});

type Step = (request: ChatRequest) => AsyncGenerator<ChatChunk>;
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
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    const run = async (text: string, onEvent: (e: EventEnvelope) => Promise<void> | void = () => undefined) => {
        const out = await post(`/api/v1/sessions/${session.id}/messages`, { text });
        const reader = out.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const events: EventEnvelope[] = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const data = /^data: (.*)$/m.exec(buffer.slice(0, idx))?.[1];
                buffer = buffer.slice(idx + 2);
                if (!data) continue;
                const e = EventEnvelope.parse(JSON.parse(data));
                events.push(e);
                await onEvent(e);
            }
        }
        return events;
    };
    return { steps, requests, req, post, run };
}

describe('/api/v1/fs/roots 与文件工具', () => {
    it('授权目录:保存 realpath;拒绝重复、不存在、相对路径与整个盘;未登录 401', async () => {
        const { req, post } = await setup();
        const created = await post('/api/v1/fs/roots', { path: path.join(base, 'Docs', 'notes', '..'), label: '文档' });
        expect(created.status).toBe(201);
        expect(FsRoot.parse(await created.json())).toMatchObject({ path: path.join(base, 'Docs'), label: '文档' });
        expect((await post('/api/v1/fs/roots', { path: path.join(base, 'Docs') })).status).toBe(409);
        expect((await post('/api/v1/fs/roots', { path: path.join(base, 'nope') })).status).toBe(400);
        expect((await post('/api/v1/fs/roots', { path: 'relative' })).status).toBe(400);
        expect((await post('/api/v1/fs/roots', { path: path.parse(base).root })).status).toBe(400);
        expect((await s.app.request('/api/v1/fs/roots')).status).toBe(401);
        const list = pageOf(FsRoot).parse(await (await req('/api/v1/fs/roots')).json()).items;
        expect(list).toHaveLength(1);
        // 默认不进入知识库;PATCH 切换(ADR 0015 第 6 节)
        expect(list[0]!.knowledgeBase).toBe(false);
        const patched = await req(`/api/v1/fs/roots/${list[0]!.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ knowledgeBase: true }),
        });
        expect(FsRoot.parse(await patched.json()).knowledgeBase).toBe(true);
        const missing = await req('/api/v1/fs/roots/01M00000000000000000000000', {
            method: 'PATCH',
            body: JSON.stringify({ knowledgeBase: true }),
        });
        expect(missing.status).toBe(404);
    });

    it('越权路径被拒绝并有审计;按目录预授权写入;撤销目录时删除相关预授权', async () => {
        const { steps, requests, req, post, run } = await setup();
        const root = FsRoot.parse(await (await post('/api/v1/fs/roots', { path: path.join(base, 'Docs') })).json());

        // 1) 读取授权目录之外的文件:工具拒绝,审计记为 denied
        steps.push(callTool('fs.read', { path: path.join(base, 'Private', 'secret.txt') }), answer('不能读。'));
        await run('读一下那个秘密文件');
        const toolMessage = requests[1]!.messages.at(-1)!;
        expect(toolMessage.content).toMatch(/outside the authorized folders/);
        expect(toolMessage.content).not.toContain('top secret');
        let audit = pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json()).items;
        expect(audit[0]).toMatchObject({ toolName: 'fs.read', risk: 'read', decision: 'denied', outcome: 'not_run' });

        // 2) 写入:需要审批;批准并记住 notes 目录(传入未规范化的路径,服务器 realpath 后保存)
        const target = path.join(base, 'Docs', 'notes', 'summary.md');
        steps.push(callTool('fs.write', { path: target, content: '# 摘要' }), answer('已写入。'));
        await run('写一份摘要', async (e) => {
            if (e.event.type !== 'approval-required') return;
            expect(e.event).toMatchObject({ toolName: 'fs.write', risk: 'write' });
            const blanket = await post(`/api/v1/approvals/${e.event.callId}`, {
                decision: 'approve',
                remember: { scope: 'always' },
            });
            expect(blanket.status).toBe(400);
            const outside = await post(`/api/v1/approvals/${e.event.callId}`, {
                decision: 'approve',
                remember: { scope: 'always', constraint: { pathPrefix: path.join(base, 'Private') } },
            });
            expect(outside.status).toBe(400);
            const ok = await post(`/api/v1/approvals/${e.event.callId}`, {
                decision: 'approve',
                remember: { scope: 'always', constraint: { pathPrefix: path.join(base, 'Docs', 'notes', '.', '') } },
            });
            expect(ok.status).toBe(200);
        });
        expect(readFileSync(target, 'utf8')).toBe('# 摘要');
        const preauths = pageOf(Preauthorization).parse(await (await req('/api/v1/preauthorizations')).json()).items;
        expect(preauths).toEqual([
            expect.objectContaining({
                toolName: 'fs.write',
                constraint: { pathPrefix: path.join(base, 'Docs', 'notes') },
            }),
        ]);

        // 3) 同一目录再次写入:预授权生效;目录外仍需审批
        steps.push(
            callTool('fs.write', { path: path.join(base, 'Docs', 'notes', 'b.md'), content: 'b' }),
            answer('ok'),
        );
        const second = await run('再写一份');
        expect(second.map((e) => e.event.type)).not.toContain('approval-required');
        expect(existsSync(path.join(base, 'Docs', 'notes', 'b.md'))).toBe(true);

        // 4) 撤销授权目录:相关预授权一并删除并审计;之后读写都被拒绝
        expect((await req(`/api/v1/fs/roots/${root.id}`, { method: 'DELETE' })).status).toBe(204);
        expect(pageOf(Preauthorization).parse(await (await req('/api/v1/preauthorizations')).json()).items).toEqual([]);
        audit = pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json()).items;
        expect(audit[0]).toMatchObject({ action: 'preauth-revoked', toolName: 'fs.write' });
        steps.push(callTool('fs.read', { path: path.join(base, 'Docs', 'report.md') }), answer('不能读。'));
        await run('读周报');
        expect(requests.at(-1)!.messages.at(-1)!.content).toMatch(/no folder has been authorized/);
        expect((await req(`/api/v1/fs/roots/${root.id}`, { method: 'DELETE' })).status).toBe(404);
    });
});

/** 只有一页文字的最小 PDF;偏移与交叉引用表按规范计算。 */
function minimalPdf(text: string): Buffer {
    const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
    const objects = [
        '',
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

describe('验收:总结 PDF 并另存为 md 只需一次审批', () => {
    it('fs.read 解析 PDF(不需要审批),fs.write 写 md(一次审批)', async () => {
        writeFileSync(path.join(base, 'Docs', 'paper.pdf'), minimalPdf('Revenue grew 12 percent in Q3'));
        const { steps, requests, post, run } = await setup();
        await post('/api/v1/fs/roots', { path: path.join(base, 'Docs') });
        const summary = '# 摘要\n\n第三季度收入增长 12%。';
        let pdfText = '';
        steps.push(
            callTool('fs.read', { path: path.join(base, 'Docs', 'paper.pdf') }),
            async function* (request) {
                pdfText = request.messages.at(-1)!.content as string;
                yield {
                    type: 'tool-call',
                    callId: 'c2',
                    name: 'fs.write',
                    input: { path: path.join(base, 'Docs', 'paper-summary.md'), content: summary },
                };
                yield { type: 'finish', reason: 'tool-calls' };
            },
            answer('已保存摘要。'),
        );
        const approvals: string[] = [];
        await run('总结 paper.pdf 并另存为 md', async (e) => {
            if (e.event.type !== 'approval-required') return;
            approvals.push(e.event.toolName ?? '');
            await post(`/api/v1/approvals/${e.event.callId}`, { decision: 'approve' });
        });
        expect(approvals).toEqual(['fs.write']);
        expect(JSON.parse(pdfText)).toMatchObject({
            untrusted: true,
            content: expect.stringContaining('Revenue grew 12 percent in Q3') as string,
        });
        expect(readFileSync(path.join(base, 'Docs', 'paper-summary.md'), 'utf8')).toBe(summary);
        expect(requests).toHaveLength(3);
    }, 30_000);
});

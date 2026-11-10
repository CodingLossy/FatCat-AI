// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地知识库的回放评测(ADR 0015):「这份 PDF 里关于退款的说法」引用到正确的文件与页码;
// 没有向量时用全文检索兜底;删除文件后分块与向量都被清理。
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatChunk, ChatRequest, ModelProvider } from '@ai-personal/providers';
import { EventEnvelope, KbSearchOutput, Session } from '@ai-personal/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
let base: string;
beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aip-kb-')));
});
afterEach(async () => {
    await s?.cleanup();
    rmSync(base, { recursive: true, force: true });
});

/** 每页一行文字的最小 PDF(与 tools 包测试中的构造相同)。 */
function buildPdf(pages: string[]): Buffer {
    const objects: string[] = [];
    const pageIds = pages.map((_, i) => 3 + i * 2);
    const fontId = 3 + pages.length * 2;
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    pages.forEach((text, i) => {
        const pageId = pageIds[i]!;
        const stream = `BT /F1 14 Tf 20 100 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
        objects[pageId] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents ${pageId + 1} 0 R ` +
            `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
        objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
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

/** 关键词决定的向量:每个维度对应一个词,让向量检索的结果可以预期。 */
const KEYWORDS = ['refund', 'office', 'company', 'holiday'];
const vectorFor = (text: string) =>
    Float32Array.from([...KEYWORDS.map((k): number => (text.toLowerCase().includes(k) ? 1 : 0)), 0.01]);

async function setup(options: { embed: boolean }) {
    const steps: Step[] = [];
    const embedCalls: string[][] = [];
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: () => {
            const next = steps.shift();
            if (!next) throw new Error('no scripted step');
            return next({ messages: [] });
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
        embed: (texts) => {
            embedCalls.push(texts);
            return Promise.resolve({ vectors: texts.map(vectorFor), model: 'fake-embed' });
        },
    };
    s = await createTestServer({}, { provider });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const post = (p: string, body: unknown = {}) =>
        s.app.request(p, { method: 'POST', headers, body: JSON.stringify(body) });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: options.embed ? ['chat', 'embed'] : ['chat'],
    });
    const ownerId = s.repos.owners.getByUsername('owner')!.id;
    /** 同步条目,等知识库索引与嵌入队列都处理完。 */
    const settle = async () => {
        await post('/api/v1/items/sync');
        await s.kb.idle();
        await s.embeddings.idle();
    };
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    const run = async (text: string) => {
        const out = await post(`/api/v1/sessions/${session.id}/messages`, { text });
        const body = await out.text();
        return body
            .split('\n\n')
            .map((block) => /^data: (.*)$/m.exec(block)?.[1])
            .filter((d): d is string => Boolean(d))
            .map((d) => EventEnvelope.parse(JSON.parse(d)));
    };
    /** 模型调用一次 kb.search,返回工具输出。 */
    const ask = async (query: string) => {
        steps.push(callTool('kb.search', { query }), answer('done'));
        const events = await run(query);
        const result = events.find((e) => e.event.type === 'tool-result')!.event as { output: unknown };
        return KbSearchOutput.parse(result.output);
    };
    return { post, ownerId, settle, ask, embedCalls };
}

/** 已嵌入的分块数(向量行由 embeddings 上的触发器同步删除,见 storage 的测试)。 */
const embedded = () => s.repos.embeddings.counts(s.repos.owners.getByUsername('owner')!.id).embedded;

describe('kb.search(回放评测)', () => {
    it('「这份 PDF 里关于退款的说法」:向量检索引用到正确的文件与页码;删除文件后分块与向量被清理', async () => {
        const { post, ownerId, settle, ask } = await setup({ embed: true });
        writeFileSync(
            path.join(base, 'handbook.pdf'),
            buildPdf([
                'Welcome to the company handbook',
                'Refund policy: customers can ask for a refund within 30 days',
                'Office hours are 9 to 6',
            ]),
        );
        writeFileSync(path.join(base, 'notes.md'), '# Holidays\nThe holiday schedule is posted in January.\n');
        writeFileSync(path.join(base, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        expect((await post('/api/v1/fs/roots', { path: base, knowledgeBase: true })).status).toBe(201);
        await settle();

        expect(s.repos.kb.counts(ownerId)).toEqual({ files: 2, chunks: 4 }); // png 不进知识库
        expect(embedded()).toBe(4);

        const out = await ask('What does the handbook say about refunds?');
        expect(out.mode).toBe('vector');
        expect(out.citations[0]).toMatchObject({ n: 1, file: 'handbook.pdf', page: 2 });
        expect(out.citations[0]!.path).toBe(path.join(base, 'handbook.pdf'));
        expect(out.content).toMatch(/^\[1\] handbook\.pdf, p\.2\nRefund policy/);
        expect(out.untrusted).toBe(true);

        // 删除文件:同步后软删除条目,知识库删除分块与向量
        unlinkSync(path.join(base, 'handbook.pdf'));
        await settle();
        expect(s.repos.kb.counts(ownerId)).toEqual({ files: 1, chunks: 1 });
        expect(embedded()).toBe(1);
        const after = await ask('refund policy');
        expect(after.citations.some((c) => c.file === 'handbook.pdf')).toBe(false);
    });

    it('没有 embed 配置档时用全文检索兜底;文件未变时不重新分块', async () => {
        const { post, ownerId, settle, ask, embedCalls } = await setup({ embed: false });
        writeFileSync(path.join(base, 'faq.txt'), 'Shipping takes five days.\n\nOffice hours are 9 to 6.');
        await post('/api/v1/fs/roots', { path: base, knowledgeBase: true });
        await settle();
        expect(s.repos.kb.counts(ownerId)).toEqual({ files: 1, chunks: 1 });
        expect(embedCalls).toEqual([]);
        expect(s.repos.embeddings.extensionLoaded).toBe(false);

        const out = await ask('office hours');
        expect(out).toMatchObject({ mode: 'fts', citations: [{ file: 'faq.txt', page: null }] });

        const before = s.repos.kb.source(out.citations[0]!.itemId)!;
        await settle();
        expect(s.repos.kb.source(out.citations[0]!.itemId)).toEqual(before);
    });
});

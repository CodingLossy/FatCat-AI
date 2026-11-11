// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件(ADR 0020):上传的类型 / 大小检查、只给本人、随消息发送、model_no_vision、删除会话与清理。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { Attachment, MAX_ATTACHMENT_BYTES, type Message, ProblemDetails, Session } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ORPHAN_GRACE_MS, sweepAttachments, UNLINKED_TTL_MS } from './attachment-files.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

/** 1×1 透明 PNG(合成)。 */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

async function setup(vision: boolean) {
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: (request) => {
            requests.push(request);
            return (async function* (): AsyncGenerator<ChatChunk> {
                yield { type: 'text-delta', delta: '一只猫' };
                yield { type: 'finish', reason: 'stop' };
            })();
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    s = await createTestServer({}, { provider, env: {} });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const auth = { cookie, 'X-CSRF-Token': csrf };
    const req = (path: string, init: RequestInit = {}) =>
        s.app.request(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    const post = (path: string, body: unknown = {}) =>
        req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
        vision,
    });
    const upload = (bytes: Uint8Array, name = 'cat.png', type = 'image/png') => {
        const form = new FormData();
        form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
        return req('/api/v1/attachments', { method: 'POST', body: form });
    };
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    const send = (body: unknown) => post(`/api/v1/sessions/${session.id}/messages?stream=false`, body);
    return { req, post, upload, session, send, requests, auth };
}

describe('上传', () => {
    it('按魔数判断类型,不信任文件名与 Content-Type;本人可读回原始字节', async () => {
        const { upload, req } = await setup(true);
        const res = await upload(PNG, '..\\..\\evil.svg', 'image/svg+xml');
        expect(res.status).toBe(201);
        const a = Attachment.parse(await res.json());
        expect(a).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, fileName: 'evil.svg', messageId: null });
        expect(existsSync(join(s.dir, 'attachments', a.id))).toBe(true);

        const got = await req(`/api/v1/attachments/${a.id}`);
        expect(got.status).toBe(200);
        expect(got.headers.get('content-type')).toBe('image/png');
        expect(got.headers.get('x-content-type-options')).toBe('nosniff');
        expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('不是图片返回 415;超过 5 MiB 返回 413;没有文件返回 400', async () => {
        const { upload, req } = await setup(true);
        const svg = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.png');
        expect(svg.status).toBe(415);
        expect(ProblemDetails.parse(await svg.json()).code).toBe('unsupported_media_type');

        const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
        big.set(PNG);
        const tooBig = await upload(big);
        expect(tooBig.status).toBe(413);
        expect(ProblemDetails.parse(await tooBig.json()).code).toBe('payload_too_large');

        const empty = await req('/api/v1/attachments', { method: 'POST', body: new FormData() });
        expect(empty.status).toBe(400);
        expect(await s.attachmentFiles.list()).toEqual([]);
    });

    it('别人的附件与不存在的一样返回 404;未登录 401', async () => {
        const { upload, req } = await setup(true);
        const a = Attachment.parse(await (await upload(PNG)).json());
        // 1.0 只有一个主人账户:把这一行改到另一个 owner 名下,模拟别人的附件
        s.conn.sqlite.pragma('foreign_keys = OFF');
        s.conn.sqlite.prepare('UPDATE message_attachments SET owner_id = ? WHERE id = ?').run('someone-else', a.id);
        s.conn.sqlite.pragma('foreign_keys = ON');
        expect((await req(`/api/v1/attachments/${a.id}`)).status).toBe(404);
        expect((await s.app.request(`/api/v1/attachments/${a.id}`)).status).toBe(401);
    });
});

describe('随消息发送', () => {
    it('图片进入消息 parts 并以原图发给支持图片的模型;同一附件不能再用', async () => {
        const { upload, send, req, session, requests } = await setup(true);
        const a = Attachment.parse(await (await upload(PNG)).json());
        const res = await send({ text: '这是什么?', attachmentIds: [a.id] });
        expect(res.status).toBe(202);
        await s.runs.idle();

        const messages = ((await (await req(`/api/v1/sessions/${session.id}/messages`)).json()) as { items: Message[] })
            .items;
        expect(messages[0]!.parts).toEqual([
            { type: 'text', text: '这是什么?' },
            { type: 'image', attachmentId: a.id, mediaType: 'image/png', fileName: 'cat.png' },
        ]);
        expect(requests[0]!.messages.at(-1)).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: '这是什么?' },
                { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
            ],
        });

        const again = await send({ text: '再看一次', attachmentIds: [a.id] });
        expect(again.status).toBe(400);
        expect(ProblemDetails.parse(await again.json()).code).toBe('validation_failed');
    });

    it('配置档没勾「支持图片」时返回 model_no_vision,不创建消息', async () => {
        const { upload, send, req, session, requests } = await setup(false);
        const a = Attachment.parse(await (await upload(PNG)).json());
        const res = await send({ text: '这是什么?', attachmentIds: [a.id] });
        expect(res.status).toBe(400);
        expect(ProblemDetails.parse(await res.json()).code).toBe('model_no_vision');
        expect(requests).toHaveLength(0);
        const list = (await (await req(`/api/v1/sessions/${session.id}/messages`)).json()) as { items: unknown[] };
        expect(list.items).toHaveLength(0);
    });

    it('不存在的附件与超过 4 张都被拒绝', async () => {
        const { upload, send } = await setup(true);
        expect((await send({ text: 'x', attachmentIds: ['01JZZZZZZZZZZZZZZZZZZZZZZZ'] })).status).toBe(400);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) ids.push(Attachment.parse(await (await upload(PNG)).json()).id);
        expect((await send({ text: 'x', attachmentIds: ids })).status).toBe(400);
    });
});

describe('删除与清理', () => {
    it('删除会话时删除附件文件', async () => {
        const { upload, send, req, session } = await setup(true);
        const a = Attachment.parse(await (await upload(PNG)).json());
        await send({ text: '看图', attachmentIds: [a.id] });
        await s.runs.idle();
        expect((await req(`/api/v1/sessions/${session.id}`, { method: 'DELETE' })).status).toBe(204);
        expect(await s.attachmentFiles.read(a.id)).toBeNull();
        expect(s.repos.attachments.exists(a.id)).toBe(false);
    });

    it('清理 24 小时内未被引用的附件与孤立文件,保留已发送的', async () => {
        const { upload, send } = await setup(true);
        const used = Attachment.parse(await (await upload(PNG)).json());
        const unused = Attachment.parse(await (await upload(PNG)).json());
        await send({ text: '看图', attachmentIds: [used.id] });
        await s.runs.idle();
        await s.attachmentFiles.write('01JXRPHANXRPHANXRPHANXRPHA', PNG);

        const later = new Date(Date.now() + Math.max(UNLINKED_TTL_MS, ORPHAN_GRACE_MS) + 1000);
        expect(await sweepAttachments(s.repos, s.attachmentFiles, later)).toBe(2);
        expect((await s.attachmentFiles.list()).map((f) => f.id)).toEqual([used.id]);
        expect(s.repos.attachments.exists(unused.id)).toBe(false);
    });
});

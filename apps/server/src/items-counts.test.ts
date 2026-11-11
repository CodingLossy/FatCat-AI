// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识地图每一层括号里的数字等于默认展开能看到的内容条数(ADR 0025)。
// 邮件同时在收件箱和已发送时,两边都列出来。任务类记忆写完就能在树上看到。
import { Item, pageOf } from '@fatcat-ai/shared';
import type { MailMessageSync } from '@fatcat-ai/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

function mail(uid: number, over: Partial<MailMessageSync> = {}): MailMessageSync {
    return {
        uid,
        messageId: `m${uid}@example.com`,
        inReplyTo: null,
        references: [],
        threadKey: `s:${uid}`,
        from: { name: '老板', address: 'boss@example.com' },
        replyTo: [],
        to: [{ name: null, address: 'me@example.com' }],
        cc: [],
        subject: `邮件 ${uid}`,
        date: new Date(Date.UTC(2026, 10, 1, 0, uid)).toISOString(),
        unread: true,
        text: `正文 ${uid}`,
        attachments: [],
        ...over,
    };
}

async function setup() {
    s = await createTestServer({}, { env: { MAIL_PW: 'pw' } });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) => s.app.request(path, { ...init, headers });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    const ownerId = s.repos.owners.ids()[0]!;
    const items = async (path: string) => pageOf(Item).parse(await (await req(path)).json()).items;
    const one = async (id: string) => Item.parse(await (await req(`/api/v1/items/${id}`)).json());

    /** 顺着默认的 children 接口往下数内容条目(隐藏的历史版本不会出现)。 */
    async function visibleContent(id: string): Promise<number> {
        let n = 0;
        let cursor: string | null = null;
        do {
            const page = pageOf(Item).parse(
                await (
                    await req(
                        `/api/v1/items/${id}/children?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
                    )
                ).json(),
            );
            for (const child of page.items) {
                if (child.kind === 'content') n += 1;
                n += await visibleContent(child.id);
            }
            cursor = page.nextCursor;
        } while (cursor);
        return n;
    }

    async function expectLevel(id: string): Promise<void> {
        const item = await one(id);
        if (item.kind === 'category') expect(item.contentCount).toBe(await visibleContent(id));
        let cursor: string | null = null;
        do {
            const page = pageOf(Item).parse(
                await (
                    await req(
                        `/api/v1/items/${id}/children?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
                    )
                ).json(),
            );
            for (const child of page.items) await expectLevel(child.id);
            cursor = page.nextCursor;
        } while (cursor);
    }

    return { req, post, ownerId, items, one, expectLevel };
}

describe('知识地图的数字', () => {
    it('每一层的数字等于展开后看到的内容;发给自己的邮件同时出现在收件箱和已发送', async () => {
        const t = await setup();
        const account = s.repos.mail.create(t.ownerId, {
            label: 'work',
            address: 'work@example.com',
            username: 'work@example.com',
            passwordRef: 'env:MAIL_PW',
            imap: { host: 'imap.example.com', port: 993, security: 'tls' },
            smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
            initialSyncDays: 30,
            syncIntervalMinutes: 5,
            appendToSent: true,
            enabled: true,
        });
        const self = mail(1, { messageId: 'self@example.com', subject: '发给自己' });
        const folder = (path: string, role: 'inbox' | 'sent', messages: MailMessageSync[]) => ({
            path,
            name: path,
            role,
            uidValidity: 1,
            highestModseq: null,
            reset: false,
            lastUid: messages.length ? Math.max(...messages.map((m) => m.uid)) : 0,
            messages,
            flags: [],
            deleted: [],
        });
        s.repos.mail.applySync(account.id, [folder('INBOX', 'inbox', [self, mail(2)]), folder('Sent', 'sent', [self])]);
        await t.post('/api/v1/memory', { text: '下周三提交周报', memType: 'episodic', subtype: 'task' });
        await t.post('/api/v1/memory', { text: '项目代号是 FatCat', memType: 'semantic', subtype: 'task' });

        const roots = await t.items('/api/v1/items/roots');
        const mailRoot = roots.find((r) => r.source === 'mail')!;
        const memoryRoot = roots.find((r) => r.source === 'memory')!;
        expect(memoryRoot.contentCount).toBe(2);
        await t.expectLevel(mailRoot.id);
        await t.expectLevel(memoryRoot.id);

        const [accountItem] = await t.items(`/api/v1/items/${mailRoot.id}/children`);
        const folders = await t.items(`/api/v1/items/${accountItem!.id}/children?sort=position`);
        expect(folders.map((f) => f.title)).toEqual(['收件箱', '已发送']);
        const sent = folders[1]!;
        expect(sent.contentCount).toBe(1);
        const sentThreads = await t.items(`/api/v1/items/${sent.id}/children`);
        const sentMessages = await t.items(`/api/v1/items/${sentThreads[0]!.id}/children`);
        expect(sentMessages.map((m) => m.title)).toEqual(['发给自己']);
        const inbox = folders[0]!;
        expect(inbox.contentCount).toBe(2);

        const domains = await t.items(`/api/v1/items/${memoryRoot.id}/children`);
        const texts: string[] = [];
        for (const domain of domains) {
            for (const group of await t.items(`/api/v1/items/${domain.id}/children`)) {
                for (const leaf of await t.items(`/api/v1/items/${group.id}/children`)) texts.push(leaf.title);
            }
        }
        expect(texts.sort()).toEqual(['下周三提交周报', '项目代号是 FatCat']);
    });
});

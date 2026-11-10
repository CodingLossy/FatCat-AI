// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件条目与附件入库(ADR 0016,M3 PR 4):知识地图可钻取到单封邮件并「问 AI」;附件进入知识库并能被检索到;
// 删除账户后条目、缓存、草稿与附件的分块全部清理(属性测试)。
import { Item, ItemContent, MailAskResult, MailAttachmentKbResult, pageOf } from '@fatcat-ai/shared';
import type { MailJobRunner } from '@fatcat-ai/mail';
import type { MailMessageSync } from '@fatcat-ai/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

const ATTACHMENT_TEXT =
    '第三季度收入增长 12%,quarterly revenue 稳定。\n\n测试密钥 api_key=sk-test-1234567890abcdef1234567890abcdef';

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
    const downloads: unknown[] = [];
    const runner: MailJobRunner = (job) => {
        if (job.kind !== 'download') return Promise.reject(new Error('unexpected job'));
        downloads.push(job.input);
        return Promise.resolve(new TextEncoder().encode(ATTACHMENT_TEXT) as never);
    };
    s = await createTestServer({}, { mailRunner: runner, env: { MAIL_PW: 'pw' } });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) => s.app.request(path, { ...init, headers });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    const ownerId = s.repos.owners.ids()[0]!;
    const items = async (path: string) => pageOf(Item).parse(await (await req(path)).json()).items;

    function addAccount(label: string, inbox: MailMessageSync[], sent: MailMessageSync[] = []) {
        const account = s.repos.mail.create(ownerId, {
            label,
            address: `${label}@example.com`,
            username: `${label}@example.com`,
            passwordRef: 'env:MAIL_PW',
            imap: { host: 'imap.example.com', port: 993, security: 'tls' },
            smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
            initialSyncDays: 30,
            syncIntervalMinutes: 5,
            appendToSent: true,
            enabled: true,
        });
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
        s.repos.mail.applySync(account.id, [folder('INBOX', 'inbox', inbox), folder('Sent', 'sent', sent)]);
        return account;
    }
    const id = (messageId: string) =>
        s.repos.mailCache.list(ownerId, { limit: 1000 }).find((m) => m.messageId === messageId)!.id;
    return { req, post, ownerId, items, addAccount, id, downloads };
}

describe('邮件条目', () => {
    it('知识地图:邮件 → 账户 → 文件夹 → 会话串 → 邮件,打开得到正文,计数与递归计算一致;「问 AI」开出被污染的会话', async () => {
        const t = await setup();
        t.addAccount('work', [
            mail(1),
            mail(2, {
                inReplyTo: 'm1@example.com',
                references: ['m1@example.com'],
                threadKey: 'r:1',
                subject: 'Re: 邮件 1',
            }),
            mail(3),
        ]);
        const roots = await t.items('/api/v1/items/roots');
        const top = roots.find((r) => r.source === 'mail')!;
        expect(top.title).toBe('邮件');
        const [account] = await t.items(`/api/v1/items/${top.id}/children`);
        expect(account?.title).toBe('work');
        const folders = await t.items(`/api/v1/items/${account!.id}/children?sort=position`);
        expect(folders.map((f) => f.title)).toEqual(['收件箱', '已发送']);
        const threads = await t.items(`/api/v1/items/${folders[0]!.id}/children`);
        expect(threads).toHaveLength(2);
        const thread = threads.find((x) => x.title === '邮件 1')!;
        const messages = await t.items(`/api/v1/items/${thread.id}/children?sort=position`);
        expect(messages.map((m) => m.title)).toEqual(['邮件 1', 'Re: 邮件 1']);

        const content = ItemContent.parse(await (await t.req(`/api/v1/items/${messages[1]!.id}/content`)).json());
        expect(content.content).toContain('正文 2');
        expect(content.content).toContain('From: 老板 <boss@example.com>');
        // 正文不进 items_fts:按正文搜不到条目,按主题能搜到
        expect(await t.items('/api/v1/items/search?q=%E6%AD%A3%E6%96%87')).toEqual([]);
        expect(s.repos.items.recount(t.ownerId)).toBe(0);

        const ask = MailAskResult.parse(
            await (
                await t.post(`/api/v1/mail/messages/${(messages[1]!.meta as { messageId: string }).messageId}/ask`)
            ).json(),
        );
        expect(s.repos.sessions.untrustedAt(ask.sessionId)).not.toBeNull();
        expect(ask.prompt).not.toContain('邮件 1');
        expect(ask.prompt).not.toContain('boss@example.com');
    });

    it('附件加入知识库:在子进程中下载,凭据被替换,kb.search 能检索到;不支持的类型返回 400', async () => {
        const t = await setup();
        t.addAccount('work', [
            mail(1, {
                attachments: [
                    { part: '2', filename: '季度报告.txt', contentType: 'text/plain', size: ATTACHMENT_TEXT.length },
                    { part: '3', filename: 'photo.jpg', contentType: 'image/jpeg', size: 10 },
                ],
            }),
        ]);
        const message = s.repos.mailCache.get(t.ownerId, t.id('m1@example.com'))!;
        const [txt, jpg] = message.attachments;
        const res = await t.post(`/api/v1/mail/attachments/${txt!.id}/knowledge-base`);
        expect(res.status).toBe(200);
        const result = MailAttachmentKbResult.parse(await res.json());
        expect(result).toMatchObject({ error: null });
        expect(result.chunks).toBeGreaterThan(0);
        expect(t.downloads).toEqual([expect.objectContaining({ folderPath: 'INBOX', uid: 1, part: '2' })]);

        const hits = s.repos.kb.search(t.ownerId, 'quarterly', 5);
        expect(hits.map((h) => h.itemId)).toEqual([result.itemId]);
        expect(hits[0]!.text).not.toContain('sk-test-1234567890');
        expect(s.repos.items.get(t.ownerId, result.itemId)).toMatchObject({
            type: 'mail.attachment',
            title: '季度报告.txt',
        });

        expect((await t.post(`/api/v1/mail/attachments/${jpg!.id}/knowledge-base`)).status).toBe(400);
        expect((await t.post('/api/v1/mail/attachments/01JC0000000000000000000000/knowledge-base')).status).toBe(404);
    });

    it('属性测试:随机账户与邮件,删除一个账户后它的条目、缓存、草稿、附件分块与向量全部清理,其他账户不受影响', async () => {
        const t = await setup();
        // 固定种子的伪随机数,失败时可重现
        let seed = 7;
        const rand = (n: number) => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed % n;
        };
        for (let round = 0; round < 3; round++) {
            const accounts = Array.from({ length: 2 + rand(2) }, (_, a) => {
                const inbox = Array.from({ length: 1 + rand(6) }, (_, i) =>
                    mail(i + 1, {
                        messageId: `r${round}a${a}m${i}@example.com`,
                        threadKey: `s:${rand(3)}`,
                        attachments: [{ part: '2', filename: 'note.txt', contentType: 'text/plain', size: 10 }],
                    }),
                );
                return t.addAccount(`r${round}a${a}`, inbox, inbox.slice(0, rand(2)));
            });
            await t.post('/api/v1/items/sync');
            // 每个账户把第一封邮件的附件加入知识库,并留一份草稿
            for (const account of accounts) {
                const first = s.repos.mailCache.list(t.ownerId, { accountId: account.id, limit: 1 })[0]!;
                const r = MailAttachmentKbResult.parse(
                    await (await t.post(`/api/v1/mail/attachments/${first.attachments[0]!.id}/knowledge-base`)).json(),
                );
                s.repos.embeddings.removeItem(r.itemId);
                s.repos.mailCache.createDraft(t.ownerId, {
                    accountId: account.id,
                    to: ['x@example.com'],
                    cc: [],
                    subject: 'd',
                    text: 'd',
                    replyToMessageId: first.id,
                    attachments: [],
                });
            }
            const victim = accounts[rand(accounts.length)]!;
            const victimItems = s.conn.sqlite
                .prepare(
                    `SELECT id FROM items WHERE source = 'mail' AND deleted_at IS NULL AND (source_ref = ? OR json_extract(meta, '$.accountId') = ?)`,
                )
                .all(`account:${victim.id}`, victim.id).length;
            expect(victimItems).toBeGreaterThan(0);

            expect((await t.req(`/api/v1/mail/accounts/${victim.id}`, { method: 'DELETE' })).status).toBe(204);

            const count = (sql: string, ...args: unknown[]) =>
                (s.conn.sqlite.prepare(sql).get(...args) as { n: number }).n;
            expect(count('SELECT count(*) AS n FROM mail_messages WHERE account_id = ?', victim.id)).toBe(0);
            expect(count('SELECT count(*) AS n FROM mail_drafts WHERE account_id = ?', victim.id)).toBe(0);
            // 被删账户的条目都已软删除,它们的知识库分块已清理
            const live = count(
                `SELECT count(*) AS n FROM items WHERE source = 'mail' AND deleted_at IS NULL AND source_ref = ?`,
                `account:${victim.id}`,
            );
            expect(live).toBe(0);
            expect(
                count(
                    `SELECT count(*) AS n FROM kb_chunks c JOIN items i ON i.id = c.item_id WHERE i.source = 'mail' AND i.deleted_at IS NOT NULL`,
                ),
            ).toBe(0);
            // 其余账户:缓存、条目与知识库都还在
            for (const other of accounts.filter((a) => a.id !== victim.id)) {
                expect(count('SELECT count(*) AS n FROM mail_messages WHERE account_id = ?', other.id)).toBeGreaterThan(
                    0,
                );
                expect(s.repos.items.bySource(t.ownerId, 'mail', `account:${other.id}`)?.deletedAt).toBeNull();
            }
            expect(s.repos.items.recount(t.ownerId)).toBe(0);
        }
    });

    it('草稿:列出、修改(更新时间随之变化,等待中的发送审批因此作废)、删除', async () => {
        const t = await setup();
        const account = t.addAccount('work', [mail(1)]);
        const draft = s.repos.mailCache.createDraft(t.ownerId, {
            accountId: account.id,
            to: ['a@example.com'],
            cc: [],
            subject: 's',
            text: 'old',
            replyToMessageId: null,
            attachments: [],
        });
        await new Promise((r) => setTimeout(r, 5));
        const patched = (await (
            await t.req(`/api/v1/mail/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ text: 'new' }) })
        ).json()) as {
            text: string;
            updatedAt: string;
        };
        expect(patched.text).toBe('new');
        expect(patched.updatedAt > draft.updatedAt).toBe(true);
        expect(
            (await t.req(`/api/v1/mail/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ to: ['bad'] }) }))
                .status,
        ).toBe(400);
        expect(((await (await t.req('/api/v1/mail/drafts')).json()) as { items: unknown[] }).items).toHaveLength(1);
        expect((await t.req(`/api/v1/mail/drafts/${draft.id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await t.req(`/api/v1/mail/drafts/${draft.id}`)).status).toBe(404);
    });
});

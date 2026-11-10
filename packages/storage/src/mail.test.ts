// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailFolderSync, MailMessageSync } from './mail.js';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
let accountId: string;
const clock = fakeClock();

const server = { host: 'imap.example.com', port: 993, security: 'tls' as const };

beforeEach(async () => {
    t = await createTestDb({ now: clock.auto() });
    accountId = t.repos.mail.create(t.ownerId, {
        label: '工作',
        address: 'me@example.com',
        username: 'me@example.com',
        passwordRef: 'env:MAIL_PW',
        imap: server,
        smtp: { ...server, host: 'smtp.example.com', port: 465 },
        initialSyncDays: 30,
        syncIntervalMinutes: 5,
        appendToSent: true,
        enabled: true,
    }).id;
});
afterEach(() => t.cleanup());

const count = (table: string) => (t.conn.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function msg(uid: number, over: Partial<MailMessageSync> = {}): MailMessageSync {
    return {
        uid,
        messageId: `m${uid}@example.com`,
        inReplyTo: null,
        references: [],
        threadKey: `s:own-${uid}`,
        from: { name: '张三', address: 'zhangsan@example.com' },
        replyTo: [],
        to: [{ name: null, address: 'me@example.com' }],
        cc: [],
        subject: `周报 ${uid}`,
        date: '2026-11-05T01:00:00.000Z',
        unread: true,
        text: `第 ${uid} 封邮件的正文,含关键词 quarterly`,
        attachments: [],
        ...over,
    };
}

function folder(path: string, over: Partial<MailFolderSync> = {}): MailFolderSync {
    return {
        path,
        name: path,
        role: path === 'INBOX' ? 'inbox' : 'sent',
        uidValidity: 1,
        highestModseq: null,
        reset: false,
        lastUid: 0,
        messages: [],
        flags: [],
        deleted: [],
        ...over,
    };
}

describe('「已发送」副本策略', () => {
    it('迁移 0011:旧的 append_to_sent=1 记为 auto,=0 记为显式 off;新建与修改时显式选择优先', async () => {
        const raw = openDatabase(':memory:');
        try {
            await migrate(
                raw.sqlite,
                migrations.filter((m) => m.id <= 10),
            );
            raw.sqlite
                .prepare(
                    `INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o', 'o', 'x', 't', 't')`,
                )
                .run();
            const insert = raw.sqlite.prepare(
                `INSERT INTO mail_accounts (id, owner_id, label, address, username, password_ref, imap_json, smtp_json,
                   initial_sync_days, sync_interval_minutes, append_to_sent, enabled, created_at, updated_at)
                 VALUES (?, 'o', 'l', 'a@163.com', 'a@163.com', 'env:X', ?, '{}', 30, 5, ?, 1, 't', 't')`,
            );
            insert.run('old-on', JSON.stringify({ host: 'imap.163.com' }), 1);
            insert.run('old-off', JSON.stringify({ host: 'imap.163.com' }), 0);
            insert.run('old-custom', JSON.stringify({ host: 'mail.example.org' }), 1);
            await migrate(raw.sqlite, migrations);
            const modes = raw.sqlite.prepare(`SELECT id, sent_copy AS m FROM mail_accounts ORDER BY id`).all();
            expect(modes).toEqual([
                { id: 'old-custom', m: 'auto' },
                { id: 'old-off', m: 'off' },
                { id: 'old-on', m: 'auto' },
            ]);
        } finally {
            raw.close();
        }

        const { mail } = t.repos;
        const base = mail.get(t.ownerId, accountId)!;
        // beforeEach 里显式传了 appendToSent: true
        expect(base.sentCopy).toBe('append');
        const withoutChoice = {
            label: 'x',
            address: 'me@example.com',
            username: 'me@example.com',
            passwordRef: 'env:MAIL_PW',
            imap: server,
            smtp: server,
            initialSyncDays: 30,
            syncIntervalMinutes: 5,
            enabled: true,
        };
        expect(mail.create(t.ownerId, withoutChoice).sentCopy).toBe('auto');
        expect(mail.create(t.ownerId, { ...withoutChoice, appendToSent: true, sentCopy: 'off' }).sentCopy).toBe('off');
        expect(mail.update(t.ownerId, accountId, { appendToSent: false })?.sentCopy).toBe('off');
        expect(mail.update(t.ownerId, accountId, { enabled: false })?.sentCopy).toBe('off');
        expect(mail.update(t.ownerId, accountId, { sentCopy: 'auto' })?.sentCopy).toBe('auto');
    });
});

describe('邮件缓存', () => {
    it('同一 Message-ID 只存一份;已读变化与删除只影响对应文件夹,不再出现在任何文件夹的邮件被清理', () => {
        const { mail } = t.repos;
        const first = mail.applySync(accountId, [
            folder('INBOX', {
                lastUid: 2,
                messages: [
                    msg(1),
                    msg(2, {
                        attachments: [{ part: '2', filename: 'a.pdf', contentType: 'application/pdf', size: 10 }],
                    }),
                ],
            }),
            // Gmail 的标签:同一封邮件出现在另一个文件夹
            folder('Sent', { lastUid: 7, messages: [msg(7, { messageId: 'm1@example.com' })] }),
        ]);
        expect(first).toEqual({ added: 2, updated: 0, removed: 0 });
        expect(count('mail_messages')).toBe(2);
        expect(count('mail_attachments')).toBe(1);

        const known = mail.knownFolders(accountId).find((f) => f.path === 'INBOX')!;
        expect(known).toMatchObject({ uidValidity: 1, lastUid: 2, uids: [1, 2], unreadUids: [1, 2] });

        const second = mail.applySync(accountId, [
            folder('INBOX', { lastUid: 2, flags: [{ uid: 1, unread: false }], deleted: [2] }),
        ]);
        expect(second).toEqual({ added: 0, updated: 1, removed: 1 });
        expect(mail.folders(accountId).find((f) => f.path === 'INBOX')).toMatchObject({
            messageCount: 1,
            unreadCount: 0,
        });
        expect(count('mail_attachments')).toBe(0);

        // 全文检索与表同步
        const hits = t.conn.sqlite
            .prepare(`SELECT count(*) AS n FROM mail_fts WHERE mail_fts MATCH '"quarterly"'`)
            .get() as {
            n: number;
        };
        expect(hits.n).toBe(1);
    });

    it('同一封邮件同时在收件箱与已发送中时,两边的筛选都能列出它(发给自己)', () => {
        const { mail, mailCache } = t.repos;
        mail.applySync(accountId, [
            folder('INBOX', { lastUid: 3, messages: [msg(3, { messageId: 'self@example.com' })] }),
            folder('Sent', { lastUid: 9, messages: [msg(9, { messageId: 'self@example.com' }), msg(8)] }),
        ]);
        const list = (f?: 'inbox' | 'sent') =>
            mailCache.list(t.ownerId, { folder: f, limit: 50 }).map((m) => [m.messageId, m.folderPath]);
        expect(list('sent').sort()).toEqual([
            ['m8@example.com', 'Sent'],
            ['self@example.com', 'Sent'],
        ]);
        expect(list('inbox')).toEqual([['self@example.com', 'INBOX']]);
        // 不筛选时每封邮件仍只出现一次
        expect(list()).toHaveLength(2);
        // 「今天未读」走收件箱筛选:先到已发送的也不会漏
        mail.applySync(accountId, [
            folder('Sent', { lastUid: 10, messages: [msg(10, { messageId: 'later@example.com' })] }),
            folder('INBOX', { lastUid: 4, messages: [msg(4, { messageId: 'later@example.com' })] }),
        ]);
        expect(
            mailCache.list(t.ownerId, { folder: 'inbox', unreadOnly: true, limit: 50 }).map((m) => m.messageId),
        ).toContain('later@example.com');
    });

    it('UIDVALIDITY 变化时清空该文件夹后重建', () => {
        const { mail } = t.repos;
        mail.applySync(accountId, [folder('INBOX', { lastUid: 2, messages: [msg(1), msg(2)] })]);
        const result = mail.applySync(accountId, [
            folder('INBOX', {
                uidValidity: 9,
                reset: true,
                lastUid: 1,
                messages: [msg(1, { messageId: 'new@example.com' })],
            }),
        ]);
        expect(result).toMatchObject({ added: 1, removed: 2 });
        expect(mail.knownFolders(accountId)[0]).toMatchObject({ uidValidity: 9, lastUid: 1, uids: [1] });
    });

    it('会话串:回复沿用原邮件的键,先到的回复也能被原邮件沿用', () => {
        const { mail } = t.repos;
        mail.applySync(accountId, [
            folder('INBOX', {
                lastUid: 3,
                messages: [
                    msg(1),
                    msg(2, { inReplyTo: 'm1@example.com', references: ['m1@example.com'], threadKey: 'r:x' }),
                    // 回复先于原邮件到达
                    msg(3, {
                        messageId: 'b2@example.com',
                        inReplyTo: 'b1@example.com',
                        references: ['b1@example.com'],
                        threadKey: 'r:b',
                    }),
                ],
            }),
        ]);
        mail.applySync(accountId, [
            folder('INBOX', { lastUid: 4, messages: [msg(4, { messageId: 'b1@example.com' })] }),
        ]);
        const keys = t.conn.sqlite.prepare('SELECT message_id AS id, thread_key AS k FROM mail_messages').all() as {
            id: string;
            k: string;
        }[];
        const key = (id: string) => keys.find((r) => r.id === id)!.k;
        expect(key('m2@example.com')).toBe(key('m1@example.com'));
        expect(key('b1@example.com')).toBe('r:b');
    });

    it('同步失败按指数退避;删除账户时缓存全部级联删除', () => {
        const { mail } = t.repos;
        mail.recordSync(accountId, { ok: false, error: 'Login failed.', intervalMinutes: 5 });
        mail.recordSync(accountId, { ok: false, error: 'Login failed.', intervalMinutes: 5 });
        const row = t.conn.sqlite.prepare('SELECT failures, next_sync_at AS next FROM mail_accounts').get() as {
            failures: number;
            next: string;
        };
        expect(row.failures).toBe(2);
        expect(mail.due(new Date(Date.parse(row.next) - 1000))).toEqual([]);
        expect(mail.get(t.ownerId, accountId)?.lastError).toBe('Login failed.');

        mail.applySync(accountId, [folder('INBOX', { lastUid: 1, messages: [msg(1)] })]);
        expect(mail.delete(t.ownerId, accountId)).toBe(true);
        for (const table of ['mail_folders', 'mail_messages', 'mail_message_folders', 'mail_attachments']) {
            expect(count(table)).toBe(0);
        }
        expect(count('mail_fts')).toBe(0);
    });
});

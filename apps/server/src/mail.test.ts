// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件账户 REST 与同步调度(ADR 0016):只收密码引用、响应不含密码;同步写入缓存;同一账户的同步不会并行。
import { MailAccount, MailConnectionTest, MailFolder, MailSyncResult } from '@ai-personal/shared';
import type { MailJob, MailJobRunner, SyncOutput } from '@ai-personal/mail';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const PASSWORD = 'imap-app-password-123';
const account = {
    label: '工作邮箱',
    address: 'me@example.com',
    username: 'me@example.com',
    passwordRef: 'env:MAIL_PW',
    imap: { host: 'imap.example.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
};

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

const syncOutput: SyncOutput = {
    folders: [
        {
            path: 'INBOX',
            name: 'INBOX',
            role: 'inbox',
            uidValidity: 1,
            highestModseq: null,
            reset: false,
            lastUid: 1,
            more: false,
            flags: [],
            deleted: [],
            messages: [
                {
                    uid: 1,
                    messageId: 'm1@example.com',
                    inReplyTo: null,
                    references: [],
                    from: { name: null, address: 'boss@example.com' },
                    replyTo: [],
                    to: [{ name: null, address: 'me@example.com' }],
                    cc: [],
                    subject: '周报',
                    date: '2026-11-05T01:00:00.000Z',
                    unread: true,
                    text: '请周五前交周报',
                    attachments: [],
                },
            ],
        },
    ],
};

async function setup(runner: MailJobRunner) {
    s = await createTestServer({}, { env: { MAIL_PW: PASSWORD }, mailRunner: runner });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const send = (method: string, p: string, body?: unknown) =>
        s.app.request(p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { cookie, send };
}

describe('邮件账户', () => {
    it('越权:未登录或缺少 CSRF 时不能添加账户;不接收明文密码;响应与日志不含密码', async () => {
        const jobs: MailJob[] = [];
        const { cookie, send } = await setup(async (job) => {
            jobs.push(job);
            return { imap: { ok: true, error: null }, smtp: { ok: false, error: `bad ${PASSWORD}` } } as never;
        });
        expect((await s.app.request('/api/v1/mail/accounts', jsonBody(account))).status).toBe(401);
        expect((await s.app.request('/api/v1/mail/accounts', jsonBody(account, { cookie }))).status).toBe(403);
        expect((await send('POST', '/api/v1/mail/accounts', { ...account, password: PASSWORD })).status).toBe(400);
        expect((await send('POST', '/api/v1/mail/accounts', { ...account, passwordRef: PASSWORD })).status).toBe(400);

        const created = await send('POST', '/api/v1/mail/accounts', account);
        expect(created.status).toBe(201);
        const body = MailAccount.parse(await created.json());
        expect(body).toMatchObject({ passwordStatus: 'present', appendToSent: true, initialSyncDays: 30 });

        const test = MailConnectionTest.parse(
            await (await send('POST', `/api/v1/mail/accounts/${body.id}/test`)).json(),
        );
        expect(test.imap.ok).toBe(true);
        // worker 给出的错误再脱敏一次
        expect(test.smtp.error).not.toContain(PASSWORD);
        expect(jobs[0]).toMatchObject({ kind: 'test', imap: { password: PASSWORD }, smtp: { server: account.smtp } });

        const all = JSON.stringify(await (await send('GET', '/api/v1/mail/accounts')).json());
        expect(all).not.toContain(PASSWORD);
        expect(s.logs.join('')).not.toContain(PASSWORD);

        const missing = await send('PATCH', `/api/v1/mail/accounts/${body.id}`, { passwordRef: 'env:NOT_SET' });
        expect(MailAccount.parse(await missing.json()).passwordStatus).toBe('missing');
        expect((await send('DELETE', `/api/v1/mail/accounts/${body.id}`)).status).toBe(204);
        expect((await send('GET', `/api/v1/mail/accounts/${body.id}`)).status).toBe(404);
    });

    it('「已发送」副本策略:不指定时为 auto,按主机算出 appendToSent;显式设置在任何主机上都保留', async () => {
        const { send } = await setup(async () => {
            throw new Error('unexpected');
        });
        const netease = { ...account, imap: { ...account.imap, host: 'imap.163.com' } };
        const create = async (body: unknown) =>
            MailAccount.parse(await (await send('POST', '/api/v1/mail/accounts', body)).json());
        const patch = async (id: string, body: unknown) =>
            MailAccount.parse(await (await send('PATCH', `/api/v1/mail/accounts/${id}`, body)).json());

        // 新账户(Web 不再传 appendToSent)
        const auto163 = await create(netease);
        expect(auto163).toMatchObject({ sentCopy: 'auto', appendToSent: false });
        expect(await create(account)).toMatchObject({ sentCopy: 'auto', appendToSent: true }); // 自定义主机
        // 显式的 appendToSent / sentCopy 不被主机覆盖;两者都给时以 sentCopy 为准
        expect(await create({ ...netease, appendToSent: true })).toMatchObject({
            sentCopy: 'append',
            appendToSent: true,
        });
        expect(await create({ ...account, appendToSent: false })).toMatchObject({
            sentCopy: 'off',
            appendToSent: false,
        });
        expect(await create({ ...account, appendToSent: true, sentCopy: 'off' })).toMatchObject({ sentCopy: 'off' });

        expect(await patch(auto163.id, { appendToSent: true })).toMatchObject({
            sentCopy: 'append',
            appendToSent: true,
        });
        // 只改别的字段时策略不变
        expect(await patch(auto163.id, { label: '163' })).toMatchObject({ sentCopy: 'append' });
        expect(await patch(auto163.id, { sentCopy: 'auto' })).toMatchObject({ sentCopy: 'auto', appendToSent: false });
        expect((await send('PATCH', `/api/v1/mail/accounts/${auto163.id}`, { sentCopy: 'always' })).status).toBe(400);
    });

    it('同步写入缓存;同一账户同时触发两次只跑一次;失败时记录已脱敏的错误', async () => {
        let calls = 0;
        let fail = false;
        let release: () => void = () => undefined;
        const { send } = await setup(async (job) => {
            calls++;
            if (job.kind !== 'sync') throw new Error('unexpected');
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            if (fail) throw new Error(`Login failed for ${PASSWORD}`);
            expect(job.input).toMatchObject({ password: PASSWORD, initialSyncDays: 30, folders: [] });
            return syncOutput as never;
        });
        const { id } = MailAccount.parse(await (await send('POST', '/api/v1/mail/accounts', account)).json());

        const a = send('POST', `/api/v1/mail/accounts/${id}/sync`);
        const b = send('POST', `/api/v1/mail/accounts/${id}/sync`);
        await new Promise((r) => setTimeout(r, 20));
        release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(MailSyncResult.parse(await ra.json())).toMatchObject({ ok: true, added: 1 });
        expect(MailSyncResult.parse(await rb.json())).toMatchObject({ ok: true, added: 1 });
        expect(calls).toBe(1);

        const folders = (await (await send('GET', `/api/v1/mail/accounts/${id}/folders`)).json()) as {
            items: unknown[];
        };
        expect(folders.items.map((f) => MailFolder.parse(f))).toMatchObject([
            { path: 'INBOX', specialUse: 'inbox', messageCount: 1, unreadCount: 1, lastUid: 1 },
        ]);

        fail = true;
        const failed = send('POST', `/api/v1/mail/accounts/${id}/sync`);
        await new Promise((r) => setTimeout(r, 20));
        release();
        const result = MailSyncResult.parse(await (await failed).json());
        expect(result.ok).toBe(false);
        expect(result.error).not.toContain(PASSWORD);
        const after = MailAccount.parse(await (await send('GET', `/api/v1/mail/accounts/${id}`)).json());
        expect(after.lastError).toBe(result.error);
        // 失败后退避:定时检查时不会立即重试
        expect(s.repos.mail.due(new Date())).toEqual([]);
    });
});

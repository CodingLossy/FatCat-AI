// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { ItemSource } from './items.js';
import {
    MailAccount,
    MailAccountInput,
    MailAccountPatch,
    MailDraftInput,
    MailMessage,
    MailSecretRef,
    MailSendInput,
    MailServer,
} from './mail.js';
import { AgentEvent } from './events.js';
import { ApprovalRequest, ApprovalWarningCode } from './tools.js';

const ID = '01M00000000000000000000000';

const account = {
    label: '工作邮箱',
    address: 'me@example.com',
    username: 'me@example.com',
    passwordRef: 'env:MAIL_PASSWORD',
    imap: { host: 'imap.example.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
};

describe('邮件契约', () => {
    it('账户:默认首次同步 30 天、每 5 分钟拉取;未知字段(如明文 password)一律拒绝', () => {
        expect(MailAccountInput.parse(account)).toMatchObject({
            initialSyncDays: 30,
            syncIntervalMinutes: 5,
            enabled: true,
        });
        // 不给 appendToSent / sentCopy 时不补默认值:策略为 auto,由服务器按主机决定(ADR 0016 第 14 节)
        expect(MailAccountInput.parse(account)).not.toHaveProperty('appendToSent');
        expect(MailAccountInput.parse(account)).not.toHaveProperty('sentCopy');
        expect(MailAccountInput.safeParse({ ...account, sentCopy: 'always' }).success).toBe(false);
        expect(MailAccountInput.safeParse({ ...account, password: 'hunter22' }).success).toBe(false);
        expect(MailAccountPatch.safeParse({ password: 'hunter22' }).success).toBe(false);
        expect(MailAccountPatch.parse({ label: '个人邮箱' })).toEqual({ label: '个人邮箱' });
    });

    it('密码只接受 env: / file: 引用', () => {
        expect(MailSecretRef.safeParse('env:QQ_MAIL_CODE').success).toBe(true);
        expect(MailSecretRef.safeParse('file:mail_163').success).toBe(true);
        for (const bad of ['abcd1234efgh', 'env:', 'file:../x', 'env:A B']) {
            expect(MailSecretRef.safeParse(bad).success).toBe(false);
        }
        expect(MailAccountInput.safeParse({ ...account, passwordRef: null }).success).toBe(false);
    });

    it('服务器:只支持 TLS / STARTTLS;主机名不能带协议、路径或凭据', () => {
        expect(MailServer.safeParse({ host: 'smtp.qq.com', port: 587, security: 'starttls' }).success).toBe(true);
        expect(MailServer.safeParse({ host: '[::1]', port: 993, security: 'tls' }).success).toBe(true);
        expect(MailServer.safeParse({ host: 'imap.qq.com', port: 143, security: 'none' }).success).toBe(false);
        for (const host of ['imaps://imap.qq.com', 'imap.qq.com/x', 'user:pw@imap.qq.com', 'imap qq.com']) {
            expect(MailServer.safeParse({ host, port: 993, security: 'tls' }).success).toBe(false);
        }
        expect(MailServer.safeParse({ host: 'imap.qq.com', port: 70_000, security: 'tls' }).success).toBe(false);
    });

    it('账户响应带 passwordStatus,不含密码', () => {
        const parsed = MailAccount.parse({
            ...account,
            id: ID,
            initialSyncDays: 30,
            syncIntervalMinutes: 5,
            enabled: true,
            sentCopy: 'auto',
            appendToSent: false,
            passwordStatus: 'missing',
            lastSyncedAt: null,
            lastError: null,
            createdAt: '2026-11-05T00:00:00.000Z',
            updatedAt: '2026-11-05T00:00:00.000Z',
        });
        expect(parsed.passwordStatus).toBe('missing');
        expect(JSON.stringify(parsed)).not.toContain('hunter');
    });

    it('邮件与草稿', () => {
        const message = {
            id: ID,
            accountId: ID,
            folderId: ID,
            uid: 42,
            messageId: 'abc@example.com',
            inReplyTo: null,
            references: [],
            threadKey: 't:abc',
            from: { name: '张三', address: 'zhangsan@example.com' },
            to: [{ name: null, address: 'me@example.com' }],
            cc: [],
            subject: '周报',
            date: '2026-11-05T01:00:00.000Z',
            unread: true,
            snippet: '本周完成了……',
            attachments: [
                { id: ID, filename: 'report.pdf', contentType: 'application/pdf', size: 1024, downloaded: false },
            ],
        };
        expect(MailMessage.parse(message).text).toBeUndefined();
        expect(MailMessage.safeParse({ ...message, from: { name: null, address: 'not-an-address' } }).success).toBe(
            false,
        );

        expect(
            MailDraftInput.parse({ accountId: ID, to: ['a@example.com'], subject: 'Re: 周报', text: '收到' }).cc,
        ).toEqual([]);
        expect(MailDraftInput.safeParse({ accountId: ID, to: [], subject: 'x', text: 'y' }).success).toBe(false);
    });

    it('草稿附件只能来自被回复邮件或授权目录;mail.send 只接受草稿 id', () => {
        const base = { accountId: ID, to: ['a@example.com'], subject: 'Re: 周报', text: '见附件' };
        expect(
            MailDraftInput.parse({
                ...base,
                attachments: [
                    { kind: 'mail', attachmentId: ID },
                    { kind: 'file', path: 'D:/Docs/周报.pdf' },
                ],
            }).attachments,
        ).toHaveLength(2);
        expect(MailDraftInput.parse(base).attachments).toEqual([]);
        expect(
            MailDraftInput.safeParse({ ...base, attachments: [{ kind: 'url', url: 'https://evil.example/x' }] })
                .success,
        ).toBe(false);
        expect(MailDraftInput.safeParse({ ...base, inReplyTo: '<x@evil.example>' }).success).toBe(false);

        expect(MailSendInput.parse({ draftId: ID })).toEqual({ draftId: ID });
        expect(MailSendInput.safeParse({ draftId: ID, to: ['x@evil.example'] }).success).toBe(false);
        expect(MailSendInput.safeParse({ to: ['x@evil.example'], subject: 'x', text: 'y' }).success).toBe(false);
    });

    it('审批警告:approval-required 事件与 ApprovalRequest 的可选 warnings,旧数据照常解析', () => {
        const warning = { code: ApprovalWarningCode.enum.recipient_untrusted, message: '收件人不在你的消息中' };
        const event = { type: 'approval-required', runId: ID, callId: 'c1', summary: '发送邮件' };
        expect(AgentEvent.parse(event)).not.toHaveProperty('warnings');
        expect(AgentEvent.parse({ ...event, warnings: [warning] })).toMatchObject({ warnings: [warning] });

        const request = {
            callId: 'c1',
            runId: ID,
            sessionId: ID,
            toolName: 'mail.send',
            risk: 'external',
            summary: '发送邮件',
            input: { draftId: ID },
            status: 'pending',
            preauthorizable: false,
            createdAt: '2026-11-05T00:00:00.000Z',
            expiresAt: '2026-11-05T00:30:00.000Z',
            decidedAt: null,
        };
        expect(ApprovalRequest.parse(request).warnings).toBeUndefined();
        expect(ApprovalRequest.parse({ ...request, warnings: [warning] }).warnings).toEqual([warning]);
        // 新代码不会让旧的解析失败:code 是字符串。
        expect(
            ApprovalRequest.safeParse({ ...request, warnings: [{ code: 'future_code', message: 'x' }] }).success,
        ).toBe(true);
    });

    it('items.source 新增 mail', () => {
        expect(ItemSource.options).toContain('mail');
    });
});

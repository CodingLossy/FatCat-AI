// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MailSentCopy } from '@ai-personal/shared';
import { describe, expect, it } from 'vitest';
import { appendsToSent, MAIL_PRESETS, planSentCopy, serverSavesSent } from './presets.js';

const account = (sentCopy: MailSentCopy, host: string) => ({ sentCopy, imap: { host } });

describe('发送后「已发送」副本(ADR 0016 第 14 节)', () => {
    it('auto:163 与 Gmail 交给服务器自动保存,其他主机(含自定义主机)由 AI-Personal APPEND', () => {
        expect(planSentCopy(account('auto', 'imap.163.com'), '已发送')).toEqual({ action: 'server', folder: null });
        expect(planSentCopy(account('auto', ' IMAP.Gmail.com '), 'Sent')).toEqual({ action: 'server', folder: null });
        expect(planSentCopy(account('auto', 'imap.qq.com'), 'Sent Messages')).toEqual({
            action: 'append',
            folder: 'Sent Messages',
        });
        expect(planSentCopy(account('auto', 'mail.example.org'), 'Sent')).toEqual({ action: 'append', folder: 'Sent' });
    });

    it('显式设置总是生效:163 上的 append 照样 APPEND,自定义主机上的 off 不 APPEND', () => {
        expect(planSentCopy(account('append', 'imap.163.com'), '已发送')).toEqual({
            action: 'append',
            folder: '已发送',
        });
        expect(planSentCopy(account('off', 'mail.example.org'), 'Sent')).toEqual({ action: 'off', folder: null });
        expect(planSentCopy(account('off', 'imap.163.com'), '已发送')).toEqual({ action: 'off', folder: null });
    });

    it('要 APPEND 但还没有「已发送」文件夹时说明原因', () => {
        expect(planSentCopy(account('append', 'mail.example.org'), null)).toEqual({
            action: 'no-sent-folder',
            folder: null,
        });
    });

    it('预设里的 appendToSent 与 auto 策略在该主机上的结果一致', () => {
        for (const p of MAIL_PRESETS) {
            expect(p.appendToSent).toBe(appendsToSent(account('auto', p.imap.host)));
            expect(p.appendToSent).toBe(!serverSavesSent(p.imap.host));
        }
        expect(MAIL_PRESETS.find((p) => p.id === '163')?.appendToSent).toBe(false);
    });
});

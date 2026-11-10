// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MailPreset } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { sentCopyDuplicate, sentCopyNote } from './sent-copy.js';

const server = (host: string) => ({ host, port: 993, security: 'tls' as const });
const presets = [
    {
        id: '163',
        label: '163',
        imap: server('imap.163.com'),
        smtp: server('smtp.163.com'),
        appendToSent: false,
        help: '',
    },
    { id: 'qq', label: 'QQ', imap: server('imap.qq.com'), smtp: server('smtp.qq.com'), appendToSent: true, help: '' },
] as MailPreset[];

describe('sent copy notes', () => {
    it('163 选「总是保存」时提示会有两份,主机大小写与空白不敏感', () => {
        expect(sentCopyDuplicate({ sentCopy: 'append', imap: server(' IMAP.163.com ') }, presets)).toBe(true);
        expect(sentCopyDuplicate({ sentCopy: 'auto', imap: server('imap.163.com') }, presets)).toBe(false);
        expect(sentCopyDuplicate({ sentCopy: 'append', imap: server('imap.qq.com') }, presets)).toBe(false);
    });

    it('「不保存」有单独的说明', () => {
        expect(sentCopyNote({ sentCopy: 'off', appendToSent: false })).toBe('mail.sentCopyNote.off');
        expect(sentCopyNote({ sentCopy: 'auto', appendToSent: false })).toBe('mail.sentCopyNote.server');
        expect(sentCopyNote({ sentCopy: 'auto', appendToSent: true })).toBe('mail.sentCopyNote.append');
        expect(sentCopyNote({ sentCopy: 'append', appendToSent: true })).toBe('mail.sentCopyNote.append');
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { describeError, parseFetched } from './client.js';

const gbkHtmlOnly = [
    'Message-ID: <r2@example.com>',
    'In-Reply-To: <r1@example.com>',
    'References: <r0@example.com> <r1@example.com>',
    'From: =?GBK?B?1cXI/Q==?= <zhangsan@example.com>',
    'To: me@example.com, undisclosed-recipients:;',
    'Subject: =?GBK?B?1tyxqA==?=',
    'Date: Thu, 05 Nov 2026 09:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=GBK',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(
        new Uint8Array([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e]), // <p>你好</p>(GBK)
    ).toString('base64'),
    '',
].join('\r\n');

describe('解析邮件', () => {
    it('GBK 编码、只有 HTML 的邮件转成纯文本;引用头去掉尖括号;无效地址被跳过;附件索引来自 BODYSTRUCTURE', async () => {
        const parsed = await parseFetched({
            seq: 1,
            uid: 7,
            flags: new Set(['\\Seen']),
            source: Buffer.from(gbkHtmlOnly, 'latin1'),
            bodyStructure: {
                type: 'multipart/mixed',
                childNodes: [
                    { part: '1', type: 'text/html', size: 20 },
                    {
                        part: '2',
                        type: 'application/pdf',
                        size: 1234,
                        disposition: 'attachment',
                        dispositionParameters: { filename: '周报.pdf' },
                    },
                ],
            },
        } as FetchMessageObject);
        expect(parsed).toMatchObject({
            uid: 7,
            messageId: 'r2@example.com',
            inReplyTo: 'r1@example.com',
            references: ['r0@example.com', 'r1@example.com'],
            from: { name: '张三', address: 'zhangsan@example.com' },
            to: [{ address: 'me@example.com' }],
            subject: '周报',
            date: '2026-11-05T01:00:00.000Z',
            unread: false,
            attachments: [{ part: '2', filename: '周报.pdf', contentType: 'application/pdf', size: 1234 }],
        });
        expect(parsed.text.trim()).toBe('你好');
    });

    it('错误说明人能看懂,不带原始凭据', () => {
        expect(describeError({ authenticationFailed: true, message: 'AUTHENTICATIONFAILED pw=secret' })).toMatch(
            /^Login failed/,
        );
        expect(describeError({ responseText: 'Unsafe Login. Please contact kefu@188.com' })).toMatch(/163/);
        expect(describeError({ code: 'ENOTFOUND' })).toMatch(/resolved/);
    });
});

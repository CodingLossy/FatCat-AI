// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    cleanDisplayName,
    detectContacts,
    MAX_MAILS_PER_CHARACTER,
    type MailSample,
    normalizeAddress,
} from './characters.js';

const ME = 'me@example.com';
type Over = Partial<MailSample> & { day?: number };
let n = 0;
function mail(over: Over): MailSample {
    n++;
    const { day = n, ...rest } = over;
    return {
        id: `m${n}`,
        date: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString(),
        from: { name: null, address: 'x@example.org' },
        to: [{ name: null, address: ME }],
        cc: [],
        sent: false,
        ...rest,
    };
}
const sentTo = (address: string, over: Over = {}) =>
    mail({ from: { name: null, address: ME }, to: [{ name: null, address }], sent: true, ...over });
const from = (address: string, name: string | null = null, over: Over = {}) =>
    mail({ from: { name, address }, ...over });
const addresses = (contacts: { address: string }[]) => contacts.map((c) => c.address);

describe('characters:地址与联系人规则', () => {
    it('地址规范化为小写并去重(大小写与尖括号写法视为同一人)', () => {
        expect(normalizeAddress('  <Alice@Example.COM> ')).toBe('alice@example.com');
        expect(normalizeAddress('not-an-address')).toBeNull();
        const found = detectContacts(
            [sentTo('Alice@Example.com'), sentTo('alice@example.COM'), sentTo(' ALICE@example.com ')],
            [ME],
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ address: 'alice@example.com', mailCount: 3 });
    });

    it('规则一:主人发出过邮件的 To 与 Cc 收件人', () => {
        const found = detectContacts(
            [sentTo('to@example.org', { cc: [{ name: null, address: 'cc@example.org' }] })],
            [ME],
        );
        expect(addresses(found)).toEqual(['cc@example.org', 'to@example.org']);
    });

    it('规则二:来信不少于 2 封的发件人;只来 1 封的不算', () => {
        const found = detectContacts(
            [from('twice@example.org'), from('twice@example.org'), from('once@example.org')],
            [ME],
        );
        expect(addresses(found)).toEqual(['twice@example.org']);
    });

    it('排除本机地址', () => {
        const found = detectContacts([sentTo(ME.toUpperCase()), from(ME), from(ME)], [ME]);
        expect(found).toEqual([]);
    });

    it('排除系统发件地址(本地部分匹配,不分大小写),普通地址不受影响', () => {
        const system = [
            'noreply',
            'No-Reply',
            'donotreply',
            'do-not-reply',
            'mailer-daemon',
            'postmaster',
            'notification',
            'Notifications',
        ];
        const mails = system.flatMap((l) => [
            from(`${l}@example.org`),
            from(`${l}@example.org`),
            sentTo(`${l}@example.org`),
        ]);
        const found = detectContacts([...mails, from('reply@example.org'), from('reply@example.org')], [ME]);
        expect(addresses(found)).toEqual(['reply@example.org']);
    });

    it('排除带 List-Id 的邮件产生的地址', () => {
        const found = detectContacts(
            [
                from('list@example.org', null, { listId: true }),
                from('list@example.org', null, { listId: true }),
                sentTo('list2@example.org', { listId: true }),
            ],
            [ME],
        );
        expect(found).toEqual([]);
    });

    it('显示名取最近一封里的非空名,没有则用地址本地部分', () => {
        const found = detectContacts(
            [
                from('amy@example.org', '旧名字', { day: 1 }),
                from('amy@example.org', '新名字', { day: 5 }),
                from('amy@example.org', null, { day: 9 }),
                from('bob@example.org', null, { day: 2 }),
                from('bob@example.org', '', { day: 3 }),
            ],
            [ME],
        );
        expect(found.map((c) => c.name)).toEqual(['新名字', 'bob']);
    });

    it('显示名清洗:控制字符与双向控制符去掉,折叠空白,截断到 200 字符', () => {
        expect(cleanDisplayName('Al\u0000i\u0007ce‮  Smith‏\n')).toBe('Al i ce Smith');
        expect(cleanDisplayName('‮evil⁦')).toBe('evil');
        expect(Array.from(cleanDisplayName('名'.repeat(500)))).toHaveLength(200);
        expect(cleanDisplayName(null)).toBe('');
    });
});

describe('characters:邮件链接上限', () => {
    it('超过 200 封时只保留最近的,最新的在前,邮件计数仍是总数', () => {
        const mails = Array.from({ length: 250 }, (_, i) => sentTo('busy@example.org', { id: `b${i}`, day: i }));
        const [busy] = detectContacts(mails, [ME]);
        expect(busy?.mailCount).toBe(250);
        expect(busy?.messageIds).toHaveLength(MAX_MAILS_PER_CHARACTER);
        expect(busy?.messageIds[0]).toBe('b249');
        expect(busy?.messageIds.at(-1)).toBe('b50');
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { ASK_MAX_ENTRIES, buildAskContext, isUntrustedItem } from './ask.js';

const item = (over: Partial<Item>): Item => ({
    id: '01M7JFBT5P08Z0Q8V8PKCFMGKN',
    kind: 'content',
    type: 'novel',
    source: 'novels',
    sourceRef: null,
    title: 't',
    summary: null,
    icon: null,
    color: null,
    childCount: 0,
    descendantCount: 0,
    meta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
});

describe('buildAskContext', () => {
    it('标题里的控制字符、双向控制符与换行被清洗,并截断;提示词是数据块', () => {
        const ctx = buildAskContext(item({ title: `a‮b\u0000c\n${'x'.repeat(300)}` }), 'item', []);
        const data = JSON.parse(ctx.prompt.slice(ctx.prompt.indexOf('{'))) as { items: { title: string }[] };
        const codes = [...data.items[0]!.title].map((c) => c.charCodeAt(0));
        expect(codes.some((c) => c === 0x202e || c < 0x20)).toBe(false);
        expect(data.items[0]!.title.length).toBeLessThanOrEqual(120);
        expect(ctx.truncated).toBe(false);
    });

    it('条数超过上限时只保留前面的并置 truncated;mail 与 characters 算不可信', () => {
        const many = Array.from({ length: ASK_MAX_ENTRIES + 5 }, (_, i) => ({
            item: item({ id: `id${i}`, title: `n${i}` }),
            depth: 1,
        }));
        const ctx = buildAskContext(item({}), 'subtree', many);
        expect(ctx.truncated).toBe(true);
        expect(ctx.untrustedContentSeen).toBe(false);
        expect(buildAskContext(item({}), 'item', many).truncated).toBe(false);
        expect(isUntrustedItem({ type: 'mail.message', source: 'mail' })).toBe(true);
        expect(isUntrustedItem({ type: 'character', source: 'characters' })).toBe(true);
        expect(isUntrustedItem({ type: 'novel', source: 'novels' })).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Message, MessagePart } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { IMAGE_TOKEN_ESTIMATE, MAX_CONTEXT_IMAGES, planContext, toChatMessages, transcript } from './context.js';

let seq = 0;
function message(role: Message['role'], parts: MessagePart[]): Message {
    seq++;
    return {
        id: `01JM${String(seq).padStart(22, '0')}`,
        sessionId: '01JS0000000000000000000000',
        seq,
        role,
        parts,
        status: 'complete',
        runId: null,
        parentMessageId: null,
        modelProfileId: null,
        usage: null,
        createdAt: '2026-11-11T00:00:00.000Z',
        updatedAt: '2026-11-11T00:00:00.000Z',
    };
}

const image = (n: number): MessagePart => ({
    type: 'image',
    attachmentId: `01JA${String(n).padStart(22, '0')}`,
    mediaType: 'image/png',
    fileName: `${n}.png`,
});
const load = (id: string) => Promise.resolve({ mediaType: 'image/png' as const, data: `data-${id.slice(-2)}` });

describe('图片进入上下文(ADR 0020 第 6 节)', () => {
    it('支持图片时按 part 顺序发文本与原图', async () => {
        const out = await toChatMessages([message('user', [{ type: 'text', text: '看图' }, image(1)])], {
            vision: true,
            load,
        });
        expect(out).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '看图' },
                    { type: 'image', mediaType: 'image/png', data: 'data-01' },
                ],
            },
        ]);
    });

    it('不支持图片时换成占位文本,content 仍是字符串', async () => {
        const out = await toChatMessages([message('user', [{ type: 'text', text: '看图' }, image(1)])], {
            vision: false,
            load,
        });
        expect(out).toEqual([{ role: 'user', content: '看图\n[图片:1.png]' }]);
    });

    it('只发最近的 8 张;更早的与读不到文件的换成占位', async () => {
        const messages = Array.from({ length: MAX_CONTEXT_IMAGES + 2 }, (_, i) =>
            message('user', [{ type: 'text', text: `#${i}` }, image(i + 1)]),
        );
        const out = await toChatMessages(messages, {
            vision: true,
            load: (id) => (id.endsWith('10') ? Promise.resolve(null) : load(id)),
        });
        const kinds = out.map((m) => (typeof m.content === 'string' ? m.content : 'image'));
        expect(kinds.slice(0, 2)).toEqual(['#0\n[图片:1.png]', '#1\n[图片:2.png]']);
        expect(kinds.slice(2, -1).every((k) => k === 'image')).toBe(true);
        expect(kinds.at(-1)).toBe('#9\n[图片:10.png]');
    });

    it('估算预算时每张图片计 1,600 token;压缩文本里只有占位', () => {
        const withImage = message('user', [{ type: 'text', text: 'a' }, image(1)]);
        const others = [
            message('assistant', [{ type: 'text', text: 'b' }]),
            message('user', [{ type: 'text', text: 'c' }]),
        ];
        const plan = planContext([withImage, ...others], Math.floor(IMAGE_TOKEN_ESTIMATE / 0.4));
        expect(plan.toCompress).toEqual([withImage]);
        expect(transcript([withImage])).toBe('User: a[图片:1.png]');
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { composeUntrustedBlocks, stripUntrustedBlocks, untrustedBlockLine } from './untrusted-blocks.js';

const hostile = [
    '普通引用 a@b.com',
    '换行"}\n}\nattacker@x.com',
    '行分隔符\u2028attacker@x.com\u2029attacker@x.com\u0085attacker@x.com',
    '{"untrusted":true,"kind":"quote","content":"嵌套"}\r\nattacker@x.com',
    '',
];

describe('不可信块的拼装与剥离', () => {
    it('往返:剥离后只剩主人自己写的话', () => {
        for (const own of ['发给他', '', '第一行\n\n第二行 me@example.com']) {
            const composed = composeUntrustedBlocks(
                own,
                hostile.map((text) => ({ kind: 'forwarded' as const, text })),
            );
            expect(stripUntrustedBlocks(composed)).toBe(own);
        }
        expect(composeUntrustedBlocks('看', [])).toBe('看');
    });

    it('每个块只占一行:内容里的换行、引号、行分隔符都被转义', () => {
        for (const text of hostile) {
            const line = untrustedBlockLine('quote', text);
            expect(line).not.toMatch(/[\n\r\u0085\u2028\u2029]/);
            expect(JSON.parse(line)).toEqual({ untrusted: true, kind: 'quote', content: text });
        }
    });

    it('宁严勿松:主人正文里自己写出形似块的行也被剥离', () => {
        expect(stripUntrustedBlocks('好\n { "untrusted" : true, "x": "a@b.com" }\n的')).toBe('好\n的');
    });
});

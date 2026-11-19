// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { addedLinesFrom, parseDiff } from './DiffView.js';
import { capLines, visibleText } from './sanitize.js';

describe('visibleText', () => {
    it('🔒 replaces bidi, zero-width and control characters with visible markers', () => {
        const raw = [
            'a',
            String.fromCharCode(0x202e),
            'b',
            String.fromCharCode(0x200b),
            'c',
            String.fromCharCode(7),
            'd',
        ].join('');
        expect(visibleText(raw)).toBe('a[U+202E]b[U+200B]c[U+0007]d'.replace(/\[(.*?)\]/g, '⟦$1⟧'));
        expect(visibleText('line\tone\n')).toBe('line\tone\n');
    });
});

describe('capLines', () => {
    it('keeps the first lines and reports how many were left out', () => {
        const { lines, more } = capLines(Array.from({ length: 700 }, (_, i) => String(i)).join('\n'));
        expect(lines).toHaveLength(500);
        expect(more).toBe(200);
    });
});

describe('parseDiff', () => {
    it('numbers lines from the hunk header', () => {
        const rows = parseDiff('@@ -3,2 +3,2 @@\n a\n-b\n+c');
        expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
            ['hunk', undefined, undefined, '@@ -3,2 +3,2 @@'],
            ['ctx', 3, 3, 'a'],
            ['del', 4, undefined, 'b'],
            ['add', undefined, 4, 'c'],
        ]);
    });

    it('falls back to showing the new content as added lines', () => {
        expect(addedLinesFrom('x\ny').map((r) => [r.kind, r.newNo])).toEqual([
            ['add', 1],
            ['add', 2],
        ]);
    });
});

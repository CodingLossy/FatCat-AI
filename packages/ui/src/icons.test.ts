// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { ICON_NAMES, iconMarkup, iconSvg, resolveIconName } from './icons.js';

describe('icons', () => {
    it('小尺寸只替换 paw,其他图标不受尺寸影响', () => {
        expect(resolveIconName('paw', 16)).toBe('paw-sm');
        expect(resolveIconName('paw', 20)).toBe('paw-sm');
        expect(resolveIconName('paw', 24)).toBe('paw');
        expect(resolveIconName('folder', 16)).toBe('folder');
    });

    it('每个图标都有内容,且只含单线图形(没有填充、没有外部引用)', () => {
        for (const name of ICON_NAMES) {
            const markup = iconMarkup(name);
            expect(markup.length, name).toBeGreaterThan(0);
            expect(markup, name).not.toMatch(/fill=|href=|url\(|<script|<image|style=/);
        }
    });

    it('iconSvg 使用 currentColor 与 1.75 描边', () => {
        const svg = iconSvg('gear', 20);
        expect(svg).toContain('stroke="currentColor"');
        expect(svg).toContain('stroke-width="1.75"');
        expect(svg).toContain('width="20"');
    });
});

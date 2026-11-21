// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

/** 去掉 CSS 注释,避免文档里的示例色值被当成硬编码。 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('design tokens', () => {
    it('tokens.css 之外的样式表不写颜色字面量(强调色规则:只用语义 token)', () => {
        const dir = join(repo, 'apps/web/src');
        const offenders: string[] = [];
        for (const name of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
            stripComments(readFileSync(join(dir, name), 'utf8'))
                .split('\n')
                .forEach((line, i) => {
                    if (COLOR_LITERAL.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
                });
        }
        expect(offenders).toEqual([]);
    });

    it('科技是默认主题(:root),不再有浅色 / 跟随系统的色板', () => {
        const css = stripComments(readFileSync(join(here, 'tokens.css'), 'utf8'));
        expect(css).toMatch(/--bg:\s*var\(--fc-black\)/);
        expect(css).not.toMatch(/prefers-color-scheme|data-theme='light'/);
        for (const name of [
            '--radius-control',
            '--border-width',
            '--shadow-panel',
            '--font-numeric',
            '--texture',
            '--glow-color',
            '--switch-radius',
            '--slider-thumb-radius',
            '--segment-radius',
            '--select-radius',
            '--hero-star-b',
        ]) {
            expect(css).toContain(`${name}:`);
        }
    });

    it('surface 是 #121216(业主 2026-11-19:原稿的 #121512 是笔误),且旧变量 --panel 映射到 --surface', () => {
        const css = stripComments(readFileSync(join(here, 'tokens.css'), 'utf8'));
        expect(css).toMatch(/--fc-obsidian:\s*#121216/);
        expect(css).not.toMatch(/#121512/);
        expect(css).toMatch(/--panel:\s*var\(--surface\)/);
    });
});

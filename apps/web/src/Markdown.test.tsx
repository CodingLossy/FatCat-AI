// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { highlightPlugins } from './highlight.js';
import { FENCE_WITH_LANG, loadHighlight, Markdown } from './Markdown.js';

const highlighted = (text: string) =>
    renderToStaticMarkup(<ReactMarkdown rehypePlugins={highlightPlugins}>{text}</ReactMarkdown>);

describe('code highlighting', () => {
    it('写明语言的代码块会高亮', () => {
        const html = highlighted('```ts\nconst x: number = 1;\n```');
        expect(html).toContain('class="hljs language-ts"');
        expect(html).toContain('<span class="hljs-keyword">const</span>');
    });

    it('别名也能识别(sh → bash)', () => {
        expect(highlighted('```sh\necho hi\n```')).toContain('hljs-built_in');
    });

    it('没写语言或语言未注册时不高亮,也不猜', () => {
        expect(highlighted('```\nconst x = 1;\n```')).not.toContain('hljs');
        expect(highlighted('```cobol\nDISPLAY "HI".\n```')).not.toContain('hljs-');
    });

    it('代码里的 HTML 按文本显示', () => {
        const html = highlighted('```html\n<script>alert(1)</script>\n```');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;');
    });

    it('只有带语言的代码块才需要加载高亮', () => {
        expect(FENCE_WITH_LANG.test('看这里:\n```ts\nx\n```')).toBe(true);
        expect(FENCE_WITH_LANG.test('~~~python\nx\n~~~')).toBe(true);
        expect(FENCE_WITH_LANG.test('```\nx\n```')).toBe(false);
        expect(FENCE_WITH_LANG.test('行内 `code` 不算')).toBe(false);
        // 只认空格与制表符缩进,全角空格不算
        expect(FENCE_WITH_LANG.test('\u3000```ts\nx\n```')).toBe(false);
    });
});

describe('Markdown', () => {
    it('高亮加载前照常显示代码,正文里的原始 HTML 不渲染', () => {
        const html = renderToStaticMarkup(
            <Markdown text={'```ts\nconst x = 1;\n```\n\n<img src=x onerror=alert(1)>'} />,
        );
        expect(html).toContain('const x = 1;');
        expect(html).not.toContain('<img');
    });
});

// 放在最后:加载成功后模块里会缓存高亮插件,之后渲染的代码块都会高亮
describe('loadHighlight', () => {
    it('加载失败后可以重试', async () => {
        await expect(loadHighlight(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
        await expect(loadHighlight(() => Promise.resolve({ highlightPlugins }))).resolves.toBe(highlightPlugins);
    });
});

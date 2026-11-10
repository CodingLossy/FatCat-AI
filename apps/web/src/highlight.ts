// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 代码高亮(ADR 0009 第 7 节),由 Markdown.tsx 按需动态加载,不进主包。
// 只高亮写明语言的代码块,不自动猜语言;只注册常用语言以控制体积。rehype-highlight 生成语法树节点,
// 不经过 innerHTML,原始 HTML 仍然不渲染。
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import rehypeHighlight, { type Options } from 'rehype-highlight';
import type { Options as MarkdownOptions } from 'react-markdown';

/** react-markdown 接受的 rehype 插件列表。 */
export type RehypePlugins = NonNullable<MarkdownOptions['rehypePlugins']>;

export const HIGHLIGHT_OPTIONS: Options = {
    detect: false,
    languages: { bash, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml },
    aliases: { bash: ['sh', 'shell', 'zsh'], xml: ['html', 'svg'], yaml: ['yml'] },
};

export const highlightPlugins: RehypePlugins = [[rehypeHighlight, HIGHLIGHT_OPTIONS]];

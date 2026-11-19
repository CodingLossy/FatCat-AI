// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 代码高亮(ADR 0009 第 7 节),由 Markdown.tsx 按需动态加载,不进主包。
// 只高亮写明语言的代码块,不自动猜语言;只注册常用语言以控制体积。rehype-highlight 生成语法树节点,
// 不经过 innerHTML,原始 HTML 仍然不渲染。
import hljs from 'highlight.js/lib/core';
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

export interface HighlightSpan {
    text: string;
    /** highlight.js 的类名(hljs-keyword 等);纯文本为 null。 */
    cls: string | null;
}

const HL_TOKEN = /<span class="([^"]*)">|<\/span>|[^<]+/g;

let registered = false;
function ensureLanguages(): void {
    if (registered) return;
    registered = true;
    const languages = HIGHLIGHT_OPTIONS.languages ?? {};
    for (const [name, def] of Object.entries(languages)) hljs.registerLanguage(name, def);
}

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** 把 highlight.js 的 HTML 收成文本片段。只认 span,不把结果交给 innerHTML。 */
export function highlightSpans(html: string): HighlightSpan[] {
    const out: HighlightSpan[] = [];
    const stack: (string | null)[] = [null];
    for (const match of html.matchAll(HL_TOKEN)) {
        if (match[0].startsWith('</')) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        if (match[1] !== undefined) {
            stack.push(match[1].split(/\s+/).find((name) => name.startsWith('hljs')) ?? null);
            continue;
        }
        const text = decodeEntities(match[0]);
        if (text) out.push({ text, cls: stack[stack.length - 1] ?? null });
    }
    return out;
}

/**
 * 一行源码的着色片段。语言必须是已注册的名字;否则(或着色失败)整行作为纯文本。
 * 调用方按文本节点渲染,不使用 innerHTML。
 */
export function highlightLine(code: string, language: string | null): HighlightSpan[] {
    if (!language || !(language in (HIGHLIGHT_OPTIONS.languages ?? {}))) return [{ text: code, cls: null }];
    try {
        ensureLanguages();
        return highlightSpans(hljs.highlight(code, { language, ignoreIllegals: true }).value);
    } catch {
        return [{ text: code, cls: null }];
    }
}

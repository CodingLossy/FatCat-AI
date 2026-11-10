// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type ComponentProps, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { RehypePlugins } from './highlight.js';
import { useI18n } from './i18n.js';

/** 写明了语言的代码块(```ts 等)。没有这样的代码块时不加载高亮代码。 */
export const FENCE_WITH_LANG = /^\s{0,3}(`{3,}|~{3,})[ \t]*[A-Za-z]/m;

let highlightPlugins: RehypePlugins | null = null;
let loading: Promise<RehypePlugins> | null = null;

/** 高亮代码(highlight.js 的语法)单独打包,第一次遇到带语言的代码块时才加载(ADR 0009 第 7 节)。 */
function loadHighlight(): Promise<RehypePlugins> {
    loading ??= import('./highlight.js').then((m) => (highlightPlugins = m.highlightPlugins));
    return loading;
}

function useHighlightPlugins(text: string): RehypePlugins {
    const wanted = FENCE_WITH_LANG.test(text);
    const [plugins, setPlugins] = useState<RehypePlugins>(highlightPlugins ?? []);
    useEffect(() => {
        if (!wanted || plugins.length > 0) return;
        let alive = true;
        loadHighlight().then(
            (p) => alive && setPlugins(p),
            () => undefined, // 加载失败时照常显示未高亮的代码
        );
        return () => {
            alive = false;
        };
    }, [wanted, plugins.length]);
    return wanted ? plugins : [];
}

/** 代码块带复制按钮;复制的是渲染后的纯文本。 */
function CodeBlock(props: ComponentProps<'pre'>) {
    const { t } = useI18n();
    const ref = useRef<HTMLPreElement>(null);
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        await navigator.clipboard.writeText(ref.current?.innerText ?? '').catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="code-block">
            <button type="button" className="copy" onClick={() => void copy()}>
                {copied ? t('chat.copied') : t('chat.copy')}
            </button>
            <pre ref={ref}>{props.children}</pre>
        </div>
    );
}

/** 不渲染原始 HTML(react-markdown 默认),链接在新窗口打开。 */
export function Markdown({ text }: { text: string }) {
    const rehypePlugins = useHighlightPlugins(text);
    return (
        <div className="markdown">
            <ReactMarkdown
                rehypePlugins={rehypePlugins}
                components={{
                    pre: CodeBlock,
                    a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer noopener">
                            {children}
                        </a>
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

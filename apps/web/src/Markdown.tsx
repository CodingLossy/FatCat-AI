// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type ComponentProps, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useI18n } from './i18n.js';

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
    return (
        <div className="markdown">
            <ReactMarkdown
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

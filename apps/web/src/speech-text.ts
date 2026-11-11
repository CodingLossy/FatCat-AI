// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 朗读前把回复的 Markdown 变成纯文本,并按句子边界切成每段 ≤ 4,000 字(ADR 0021 第 4 节)。服务器不解析 Markdown。
import { MAX_SPEECH_CHARS } from '@fatcat-ai/shared';

/** 代码块换成一句提示;链接与图片只读文字;去掉标题、强调、列表与引用的标记。 */
export function markdownToSpeech(markdown: string, codeOmitted: string): string {
    return (
        markdown
            .replace(/```[\s\S]*?(```|$)/g, `\n${codeOmitted}\n`)
            .replace(/~~~[\s\S]*?(~~~|$)/g, `\n${codeOmitted}\n`)
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/`([^`]*)`/g, '$1')
            .replace(/^[ \t]{0,3}#{1,6}\s+/gm, '')
            .replace(/^[ \t]{0,3}>\s?/gm, '')
            .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
            .replace(/^\s*([-*_]\s*){3,}$/gm, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
            // 下划线只在词的边界上才算强调,snake_case 与 __init__ 这类标识符保持原样
            .replace(/(?<![\p{L}\p{N}_])__(\S(?:.*?\S)?)__(?![\p{L}\p{N}_])/gu, '$1')
            .replace(/(?<![\p{L}\p{N}_])_(\S(?:.*?\S)?)_(?![\p{L}\p{N}_])/gu, '$1')
            .replace(/~~(.+?)~~/g, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/\|/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    );
}

/** 按句子边界切段;一句本身超过上限时硬切。 */
export function splitForSpeech(text: string, max = MAX_SPEECH_CHARS): string[] {
    // 句末:中文全角的 。！？；、英文的 !?; 与换行;英文句号只在后面是空白或结尾时才算(3.14、example.com 不切)
    const sentences =
        text.match(/(?:[^。！？；!?;\n.]|\.(?=\S))+(?:[。！？；!?;\n]|\.(?!\S))*|(?:[。！？；!?;\n]|\.(?!\S))+/g) ?? [];
    const out: string[] = [];
    let current = '';
    const flush = () => {
        if (current.trim()) out.push(current.trim());
        current = '';
    };
    for (const sentence of sentences) {
        if (current.length + sentence.length <= max) {
            current += sentence;
            continue;
        }
        flush();
        for (let i = 0; i < sentence.length; i += max) {
            const piece = sentence.slice(i, i + max);
            if (piece.length === max) out.push(piece.trim());
            else current = piece;
        }
    }
    flush();
    return out.filter((s) => s.length > 0);
}

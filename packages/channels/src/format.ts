// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 富文本降级与切段(ADR 0022 第 7 节)。

const FENCE = /^\s*(```|~~~)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
}

function inline(text: string): string {
    return (
        text
            // 图片在链接之前处理
            .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, _alt: string, url: string) => `[图片] ${url}`)
            .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
                label === url ? url : `${label} (${url})`,
            )
            .replace(/`([^`]+)`/g, '$1')
            .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
            .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2')
            .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
            .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    );
}

/**
 * Markdown → 纯文本(微信 1.0):标题去掉 #;列表保留 - / 1.;粗斜体去掉标记;代码块保留原文、去掉围栏;
 * 链接写成「文字 (网址)」;图片写成「[图片] 网址」;表格每行转成「列: 值」。
 */
export function markdownToPlainText(markdown: string): string {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const fenceMatch = FENCE.exec(line);
        if (fence) {
            if (fenceMatch && fenceMatch[1] === fence) fence = null;
            else out.push(line);
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1]!;
            continue;
        }
        // 表格:表头行 + 分隔行
        const next = lines[i + 1];
        if (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next)) {
            const header = cells(line).map(inline);
            i += 1;
            while (i + 1 < lines.length && lines[i + 1]!.includes('|') && lines[i + 1]!.trim() !== '') {
                i += 1;
                const row = cells(lines[i]!).map(inline);
                out.push(row.map((value, k) => (header[k] ? `${header[k]}: ${value}` : value)).join('; '));
            }
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // 分隔线
        const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            out.push(inline(heading[1]!));
            continue;
        }
        const bullet = /^(\s*)[*+-]\s+(.*)$/.exec(line);
        if (bullet) {
            out.push(`${bullet[1]!}- ${inline(bullet[2]!)}`);
            continue;
        }
        out.push(inline(line.replace(/^\s{0,3}>\s?/, '')));
    }
    return out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

/** 一轮最多发几段;超出的部分改成一句提示。 */
export const MAX_PARTS = 10;
export const TRUNCATED_NOTICE = '完整回答请在 Web 查看';
/** 「\n(10/10)」的最大字节数。 */
const SUFFIX_BYTES = 8;

/** 按字符(码位)切,不切断 UTF-8 字符与代理对。 */
function splitChars(text: string, max: number): string[] {
    const out: string[] = [];
    let current = '';
    let size = 0;
    for (const ch of text) {
        const n = bytes(ch);
        if (size + n > max && current) {
            out.push(current);
            current = '';
            size = 0;
        }
        current += ch;
        size += n;
    }
    if (current) out.push(current);
    return out;
}

/** 把若干块按分隔符尽量合并,每段不超过 max;单块太长时交给 fallback 继续切。 */
function pack(blocks: string[], sep: string, max: number, fallback: (block: string) => string[]): string[] {
    const out: string[] = [];
    let current = '';
    for (const block of blocks) {
        const pieces = bytes(block) > max ? fallback(block) : [block];
        for (const piece of pieces) {
            const joined = current ? current + sep + piece : piece;
            if (bytes(joined) <= max) {
                current = joined;
            } else {
                if (current) out.push(current);
                current = piece;
            }
        }
    }
    if (current) out.push(current);
    return out;
}

/**
 * 切段(ADR 0022 第 7 节):超过 maxBytes 时按段落 → 行 → 字符的顺序切;多于一段时每段末尾加「(1/3)」;
 * 最多 MAX_PARTS 段,超出的部分改成「完整回答请在 Web 查看」。每段(含后缀)都不超过 maxBytes。
 */
export function splitMessage(text: string, maxBytes: number): string[] {
    if (bytes(text) <= maxBytes) return [text];
    const max = Math.max(1, maxBytes - SUFFIX_BYTES);
    let parts = pack(text.split(/\n{2,}/), '\n\n', max, (para) =>
        pack(para.split('\n'), '\n', max, (line) => splitChars(line, max)),
    );
    if (parts.length > MAX_PARTS) parts = [...parts.slice(0, MAX_PARTS - 1), TRUNCATED_NOTICE];
    return parts.map((p, i) => `${p}\n(${i + 1}/${parts.length})`);
}

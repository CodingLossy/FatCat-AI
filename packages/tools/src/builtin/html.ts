// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把 HTML 粗略转成纯文本给模型读:去掉脚本、样式与标签,块级元素换行,解码常见实体。不执行任何脚本。

const NAMED: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    middot: '·',
};

export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return NAMED[body.toLowerCase()] ?? match;
    });
}

/** 返回标题与正文文本。 */
export function htmlToText(html: string): { title: string | null; text: string } {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/\s+/g, ' ').trim()) || null : null;
    const text = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<(br|hr)\b[^>]*>/gi, '\n')
        .replace(
            /<\/?(p|div|section|article|header|footer|main|nav|aside|li|ul|ol|tr|table|h[1-6]|pre|blockquote)\b[^>]*>/gi,
            '\n',
        )
        .replace(/<\/?(td|th)\b[^>]*>/gi, '\t')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map((line) =>
            decodeEntities(line)
                .replace(/[ \t\u00a0]+/g, ' ')
                .trim(),
        )
        .filter((line, i, lines) => line !== '' || (i > 0 && lines[i - 1] !== ''))
        .join('\n')
        .trim();
    return { title, text };
}

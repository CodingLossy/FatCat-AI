// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具结果可视化的文本处理(ADR 0046 第 7 节):只产出纯文本;控制字符与双向字符换成可见标记,大小有上限。

export const MAX_VISIBLE_LINES = 500;
export const MAX_VISIBLE_BYTES = 64 * 1024;

// C0(除 \n \t)、DEL、C1、零宽与方向控制字符、行 / 段分隔符、BOM
// eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** 把看不见的、会让文本在视觉上重排的字符换成 ⟦U+XXXX⟧(「Trojan Source」)。 */
export function visibleText(text: string): string {
    return text.replace(HIDDEN, (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);
}

/** 只留前 MAX_VISIBLE_LINES 行 / MAX_VISIBLE_BYTES;more 是被省略的行数,「显示更多」从已收到的文本里取。 */
export function capLines(
    text: string,
    maxLines = MAX_VISIBLE_LINES,
    maxBytes = MAX_VISIBLE_BYTES,
): { lines: string[]; more: number } {
    const all = text.split(/\r\n|\n/);
    const lines: string[] = [];
    let bytes = 0;
    for (const line of all) {
        bytes += line.length * 3 + 1; // 估算 UTF-8 字节上限,避免逐行编码
        if (lines.length >= maxLines || bytes > maxBytes) break;
        lines.push(line);
    }
    return { lines, more: all.length - lines.length };
}

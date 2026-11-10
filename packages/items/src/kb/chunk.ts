// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 按标题与段落分块(ADR 0015 第 2 节):段落尽量完整,超过块大小的段落按句子或字符切开;
// 每块记下所在的 PDF 页码与最近的标题(Markdown 标题、XLSX 工作表名)。
import type { KbChunkInput } from '@fatcat-ai/storage';

/** 一次最多保存的块数(约 2 MB 文本),超出时丢弃后面的部分并记录。 */
export const MAX_CHUNKS_PER_FILE = 2000;

const PAGE_MARKER = /^--- page (\d+) ---$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

interface Block {
    page: number | null;
    heading: string | null;
    text: string;
}

/** 把过长的段落按句末标点切开,仍然过长时按字符切开。 */
function splitLong(text: string, size: number): string[] {
    if (text.length <= size) return [text];
    const sentences = text.match(/[^。！？!?.;；\n]+[。！？!?.;；]*\s*/g) ?? [text];
    const out: string[] = [];
    let current = '';
    for (const s of sentences) {
        if (current && current.length + s.length > size) {
            out.push(current.trim());
            current = '';
        }
        if (s.length > size) {
            for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size).trim());
        } else {
            current += s;
        }
    }
    if (current.trim()) out.push(current.trim());
    return out.filter((t) => t.length > 0);
}

/**
 * 分块。pdf 为 true 时识别 parse 写入的 `--- page N ---` 分页行(只对 PDF 识别,
 * 普通文本里同样的行不会被当成页码)。
 */
export function chunkText(text: string, options: { size: number; pdf?: boolean }): KbChunkInput[] {
    const { size } = options;
    const blocks: Block[] = [];
    let page: number | null = options.pdf ? 1 : null;
    let heading: string | null = null;
    let paragraph: string[] = [];

    const flush = () => {
        const body = paragraph.join('\n').trim();
        paragraph = [];
        if (body) blocks.push({ page, heading, text: body });
    };

    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trimEnd();
        const marker = options.pdf ? PAGE_MARKER.exec(line.trim()) : null;
        if (marker) {
            flush();
            page = Number(marker[1]);
            continue;
        }
        const h = HEADING.exec(line);
        if (h) {
            flush();
            heading = h[2]!.slice(0, 200);
            continue;
        }
        if (line.trim() === '') {
            flush();
            continue;
        }
        paragraph.push(line);
    }
    flush();

    // 同一页、同一标题下的段落合并到块大小;跨页或换标题时另起一块,保证引用的页码准确
    const chunks: KbChunkInput[] = [];
    let current: Block | null = null;
    const push = () => {
        if (current?.text) chunks.push({ page: current.page, heading: current.heading, text: current.text });
        current = null;
    };
    for (const block of blocks) {
        for (const piece of splitLong(block.text, size)) {
            const c: Block | null = current;
            if (c && c.page === block.page && c.heading === block.heading && c.text.length + piece.length + 2 <= size) {
                c.text += `\n\n${piece}`;
            } else {
                push();
                current = { page: block.page, heading: block.heading, text: piece };
            }
            if (chunks.length >= MAX_CHUNKS_PER_FILE) return chunks;
        }
    }
    push();
    return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

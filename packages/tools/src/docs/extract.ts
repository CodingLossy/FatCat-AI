// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文档文本提取(在 worker 中运行,也可直接调用以便单测):Markdown / 纯文本、PDF(unpdf,按需加载)、DOCX、XLSX。
// 只提取文本,不执行任何宏或脚本,也不访问网络。
import { decodeEntities } from '../builtin/html.js';
import { DocumentError, ZipReader } from './zip.js';

export type DocumentKind = 'text' | 'pdf' | 'docx' | 'xlsx';

export interface ExtractedDocument {
    kind: DocumentKind;
    text: string;
    /** PDF 的页数或 XLSX 的工作表数。 */
    parts?: number;
}

/** 按扩展名判断格式;不是这些格式时返回 null(按普通文本读取)。 */
export function documentKind(file: string): Exclude<DocumentKind, 'text'> | null {
    const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx') return 'xlsx';
    return null;
}

/** 每个工作表最多导出的行数(XLSX)。 */
export const MAX_SHEET_ROWS = 5000;

const xmlText = (s: string) => decodeEntities(s);

/** DOCX:word/document.xml 中的段落、制表符、换行与表格单元格。 */
export function extractDocx(data: Buffer): ExtractedDocument {
    const zip = new ZipReader(data);
    const xml = zip.text('word/document.xml');
    if (xml === null) throw new DocumentError('not a Word document (word/document.xml is missing)');
    const body = xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
        .replace(/<\/w:tc>/g, '\t')
        .replace(/<\/w:(p|tr)>/g, '\n');
    let text = '';
    // 只取 <w:t> 中的文字(以及上面替换出的制表符与换行),其余标签与属性丢弃
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\t|\n)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) text += m[1] !== undefined ? xmlText(m[1]) : m[2];
    return {
        kind: 'docx',
        text: text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
    };
}

/** 列名(A、B、…、AA)转成从 0 开始的列号。 */
function columnIndex(ref: string): number {
    const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? 'A';
    let n = 0;
    for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
}

/** XLSX:按工作表导出制表符分隔的文本;共享字符串、内联字符串、布尔值与数字都按显示文本处理。 */
export function extractXlsx(data: Buffer): ExtractedDocument {
    const zip = new ZipReader(data);
    const workbook = zip.text('xl/workbook.xml');
    if (workbook === null) throw new DocumentError('not an Excel workbook (xl/workbook.xml is missing)');
    const rels = zip.text('xl/_rels/workbook.xml.rels') ?? '';
    const targets = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
        const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
        if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
    const shared: string[] = [];
    for (const si of (zip.text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push([...si[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join(''));
    }
    const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
        name: xmlText(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet'),
        target: targets.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '',
    }));
    const out: string[] = [];
    for (const sheet of sheets) {
        const xml = sheet.target ? zip.text(`xl/${sheet.target}`) : null;
        out.push(`## ${sheet.name}`);
        if (xml === null) continue;
        let rows = 0;
        for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            if (++rows > MAX_SHEET_ROWS) {
                out.push(`… (more than ${MAX_SHEET_ROWS} rows; the rest is omitted)`);
                break;
            }
            const cells: string[] = [];
            for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = c[1]!;
                const inner = c[2] ?? '';
                const col = columnIndex(
                    /\br="([A-Z]+)\d*"/i.exec(attrs)?.[1] ?? String.fromCharCode(65 + cells.length),
                );
                const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
                const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
                let value: string;
                if (type === 's') value = shared[Number(v)] ?? '';
                else if (type === 'inlineStr')
                    value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join('');
                else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
                else value = v !== undefined ? xmlText(v) : '';
                while (cells.length < col) cells.push('');
                cells[col] = value.replace(/[\t\r\n]+/g, ' ');
            }
            out.push(cells.join('\t').replace(/\t+$/, ''));
        }
        out.push('');
    }
    return { kind: 'xlsx', text: out.join('\n').trim(), parts: sheets.length };
}

/** PDF:按页提取文本(unpdf 内含 pdf.js,首次使用时才加载)。 */
export async function extractPdf(data: Buffer): Promise<ExtractedDocument> {
    const { extractText, getDocumentProxy } = await import('unpdf');
    let pdf;
    try {
        pdf = await getDocumentProxy(new Uint8Array(data));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DocumentError(
            /password/i.test(message) ? 'encrypted PDFs are not supported' : `not a readable PDF: ${message}`,
        );
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    // unpdf 的类型声明不完整;destroy 释放 pdf.js 的内部资源
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
    return {
        kind: 'pdf',
        text: pages.map((page, i) => `--- page ${i + 1} ---\n${page.trim()}`).join('\n\n'),
        parts: totalPages,
    };
}

export async function extractDocument(kind: Exclude<DocumentKind, 'text'>, data: Buffer): Promise<ExtractedDocument> {
    switch (kind) {
        case 'pdf':
            return extractPdf(data);
        case 'docx':
            return extractDocx(data);
        case 'xlsx':
            return extractXlsx(data);
    }
}

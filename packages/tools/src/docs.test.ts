// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createFsTools,
    documentKind,
    DocumentError,
    extractDocx,
    extractPdf,
    extractXlsx,
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENT_CHARS,
    parseInWorker,
    type ToolContext,
    ZipReader,
} from './index.js';
import { buildDocx, buildPdf, buildXlsx, buildZip } from './test-helpers.js';

const ctx: ToolContext = {
    ownerId: 'o',
    sessionId: 's',
    runId: 'r',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

describe('ZipReader', () => {
    it('读取 stored 与 deflate 条目;不存在的条目返回 null', () => {
        for (const store of [true, false]) {
            const zip = new ZipReader(buildZip({ 'a.txt': '你好', 'dir/b.xml': '<x/>' }, { store }));
            expect(zip.names()).toEqual(['a.txt', 'dir/b.xml']);
            expect(zip.text('a.txt')).toBe('你好');
            expect(zip.has('dir/b.xml')).toBe(true);
            expect(zip.read('missing')).toBeNull();
        }
    });

    it('拒绝非 ZIP、加密、损坏、ZIP 炸弹与超出总量', () => {
        expect(() => new ZipReader(Buffer.from('hello world, definitely not a zip file'))).toThrow(/not a ZIP/);
        expect(() => new ZipReader(buildZip({ 'a.txt': 'x' }, { flags: 1 }))).toThrow(/encrypted/);
        const bomb = buildZip({ 'big.txt': 'a'.repeat(1_000_000) });
        expect(() => new ZipReader(bomb, { maxEntryBytes: 1000, maxTotalBytes: 10_000 }).read('big.txt')).toThrow(
            /too large/,
        );
        const two = new ZipReader(buildZip({ a: 'x'.repeat(600), b: 'y'.repeat(600) }), {
            maxEntryBytes: 1000,
            maxTotalBytes: 1000,
        });
        expect(two.text('a')).toHaveLength(600);
        expect(() => two.read('b')).toThrow(/too large to extract/);
        const corrupt = buildZip({ 'a.txt': 'hello' });
        corrupt.writeUInt32LE(0, 0); // 破坏本地文件头
        expect(() => new ZipReader(corrupt).read('a.txt')).toThrow(/corrupt/);
        const odd = buildZip({ 'a.txt': 'hello' }, { store: true });
        odd.writeUInt16LE(12, 8); // 本地头的压缩方法改为 bzip2
        odd.writeUInt16LE(12, odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
        expect(() => new ZipReader(odd).read('a.txt')).toThrow(/compression method 12/);
    });
});

describe('DOCX / XLSX / PDF 提取', () => {
    it('DOCX:段落、制表符、换行、表格与实体', () => {
        const doc = extractDocx(
            buildDocx(
                '<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">A &amp; B</w:t></w:r></w:p>' +
                    '<w:p><w:r><w:t>第二行</w:t><w:br/><w:t>续行</w:t></w:r></w:p>' +
                    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
            ),
        );
        expect(doc).toEqual({ kind: 'docx', text: '第一段\tA & B\n第二行\n续行\n甲\n\t乙' });
        expect(() => extractDocx(buildZip({ 'other.xml': '<x/>' }))).toThrow(/not a Word document/);
    });

    it('XLSX:共享字符串、内联字符串、布尔、数字、空单元格与多个工作表', () => {
        const xlsx = extractXlsx(
            buildXlsx(
                [
                    {
                        name: '销售',
                        rowsXml:
                            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
                            '<row r="2"><c r="A2" t="inlineStr"><is><t>杭州</t></is></c><c r="B2"><v>42.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
                            '<row r="3"><c r="A3"/></row>',
                    },
                    { name: 'Notes &amp; misc', rowsXml: '<row r="1"><c r="B1" t="s"><v>2</v></c></row>' },
                ],
                ['城市', '已完成', 'x &lt; y'],
            ),
        );
        expect(xlsx).toEqual({
            kind: 'xlsx',
            parts: 2,
            text: '## 销售\n城市\t\t已完成\n杭州\t42.5\tTRUE\n\n\n## Notes & misc\n\tx < y',
        });
        expect(() => extractXlsx(buildZip({ 'a.xml': '<x/>' }))).toThrow(/not an Excel workbook/);
    });

    it('PDF:按页提取文本;不是 PDF 时报错', async () => {
        const pdf = await extractPdf(buildPdf(['Hello PDF page one', 'Second page text']));
        expect(pdf.kind).toBe('pdf');
        expect(pdf.parts).toBe(2);
        expect(pdf.text).toMatch(/--- page 1 ---\nHello PDF page one/);
        expect(pdf.text).toMatch(/--- page 2 ---\nSecond page text/);
        await expect(extractPdf(Buffer.from('not a pdf at all'))).rejects.toThrow(DocumentError);
    });

    it('按扩展名识别格式', () => {
        expect(documentKind('a/b/Report.PDF')).toBe('pdf');
        expect(documentKind('x.docx')).toBe('docx');
        expect(documentKind('x.xlsx')).toBe('xlsx');
        expect(documentKind('notes.md')).toBeNull();
        expect(documentKind('noext')).toBeNull();
    });
});

describe('worker 中解析', () => {
    it('在 worker 中解析 PDF 与 DOCX;损坏文档的错误从 worker 传回;超时与过大文件被拒绝', async () => {
        const pdf = await parseInWorker('pdf', buildPdf(['From the worker']));
        expect(pdf.text).toContain('From the worker');
        const docx = await parseInWorker('docx', buildDocx('<w:p><w:r><w:t>worker docx</w:t></w:r></w:p>'));
        expect(docx.text).toBe('worker docx');
        await expect(parseInWorker('docx', Buffer.from('garbage'))).rejects.toThrow(/not a ZIP/);
        await expect(parseInWorker('pdf', buildPdf(['x']), { timeoutMs: 1 })).rejects.toThrow(/too long/);
        await expect(parseInWorker('pdf', Buffer.alloc(MAX_DOCUMENT_BYTES + 1))).rejects.toThrow(/larger than/);
    }, 30_000);
});

describe('fs.read 读取文档', () => {
    let root: string;
    beforeEach(() => {
        root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aip-docs-')));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('PDF / DOCX / XLSX 转为文本并标为不可信;offset 按字符继续读', async () => {
        writeFileSync(path.join(root, 'r.pdf'), buildPdf(['Quarterly report']));
        writeFileSync(path.join(root, 'w.docx'), buildDocx('<w:p><w:r><w:t>会议纪要</w:t></w:r></w:p>'));
        writeFileSync(
            path.join(root, 's.xlsx'),
            buildXlsx([{ name: 'S', rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }]),
        );
        const read = createFsTools({ roots: () => [root] }).find((t) => t.name === 'fs.read')!;
        expect(await read.execute({ path: 'r.pdf' }, ctx)).toMatchObject({
            untrusted: true,
            source: { kind: 'file', ref: path.join(root, 'r.pdf') },
            content: expect.stringContaining('Quarterly report') as string,
            truncated: false,
        });
        expect(await read.execute({ path: 'w.docx' }, ctx)).toMatchObject({ content: '会议纪要' });
        expect(await read.execute({ path: 's.xlsx' }, ctx)).toMatchObject({ content: '## S\n1' });

        const long = 'x'.repeat(MAX_DOCUMENT_CHARS + 10);
        const fake = createFsTools({
            roots: () => [root],
            parse: (kind) => Promise.resolve({ kind, text: long }),
        }).find((t) => t.name === 'fs.read')!;
        expect(await fake.execute({ path: 'w.docx' }, ctx)).toMatchObject({ truncated: true });
        expect(await fake.execute({ path: 'w.docx', offset: MAX_DOCUMENT_CHARS }, ctx)).toMatchObject({
            content: 'x'.repeat(10),
            truncated: false,
        });
    }, 30_000);
});

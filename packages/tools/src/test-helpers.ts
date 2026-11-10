// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 测试用的文档构造器:最小的 ZIP(DOCX / XLSX)与 PDF。只在测试中使用,不进入覆盖率统计。
import { crc32, deflateRawSync } from 'node:zlib';

export function buildZip(
    files: Record<string, string | Buffer>,
    options: { store?: boolean; flags?: number } = {},
): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const compressed = options.store ? data : deflateRawSync(data);
        const method = options.store ? 0 : 8;
        const nameBuf = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(options.flags ?? 0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(options.flags ?? 0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + compressed.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function buildDocx(paragraphsXml: string): Buffer {
    return buildZip({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${paragraphsXml}</w:body></w:document>`,
    });
}

export function buildXlsx(sheets: { name: string; rowsXml: string }[], sharedStrings: string[] = []): Buffer {
    const files: Record<string, string> = {
        'xl/workbook.xml': `<workbook><sheets>${sheets
            .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
            .join('')}</sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships>${sheets
            .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
            .join('')}</Relationships>`,
        'xl/sharedStrings.xml': `<sst>${sharedStrings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
    };
    sheets.forEach((s, i) => {
        files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${s.rowsXml}</sheetData></worksheet>`;
    });
    return buildZip(files);
}

/** 只含 ASCII 文本的多页 PDF(Helvetica);偏移与交叉引用表按规范计算。 */
export function buildPdf(pages: string[]): Buffer {
    const objects: string[] = [];
    const pageIds = pages.map((_, i) => 3 + i * 2);
    const fontId = 3 + pages.length * 2;
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    pages.forEach((text, i) => {
        const pageId = pageIds[i]!;
        const stream = `BT /F1 14 Tf 20 100 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
        objects[pageId] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents ${pageId + 1} 0 R ` +
            `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
        objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

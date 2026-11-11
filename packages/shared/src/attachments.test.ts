// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { Attachment, AttachmentIds, sanitizeFileName, sniffImageType } from './attachments.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const ID_A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const ID_B = '01JBBBBBBBBBBBBBBBBBBBBBBB';

describe('sniffImageType', () => {
    it('按魔数识别四种图片', () => {
        expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
        expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
        expect(sniffImageType(bytes(...ascii('GIF87a')))).toBe('image/gif');
        expect(sniffImageType(bytes(...ascii('GIF89a')))).toBe('image/gif');
        expect(sniffImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')))).toBe('image/webp');
    });

    it('其他内容、截断的头与 RIFF 的其他格式都不算图片', () => {
        expect(sniffImageType(bytes())).toBeNull();
        expect(sniffImageType(bytes(0x89, 0x50, 0x4e))).toBeNull();
        expect(sniffImageType(bytes(...ascii('GIF88a')))).toBeNull();
        expect(sniffImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')))).toBeNull();
        expect(sniffImageType(bytes(...ascii('<svg xmlns=')))).toBeNull();
    });
});

describe('sanitizeFileName', () => {
    it('去掉路径与控制字符', () => {
        expect(sanitizeFileName('C:\\Users\\me\\猫.png', 'image/png')).toBe('猫.png');
        expect(sanitizeFileName('../../etc/passwd', 'image/png')).toBe('passwd');
        expect(sanitizeFileName('a\u0000b\nc.jpg', 'image/jpeg')).toBe('abc.jpg');
        expect(sanitizeFileName('a\u0085b\u009f.png', 'image/png')).toBe('ab.png');
        // 去掉 RLO 后按存储顺序显示,不再伪装成 .jpg
        expect(sanitizeFileName('photo\u202egpj.exe', 'image/png')).toBe('photogpj.exe');
        expect(sanitizeFileName('\u2066x\u2069\u200f.png', 'image/png')).toBe('x.png');
        // 零宽与不可见格式字符
        expect(sanitizeFileName('\ufeffa\u200bb\u200dc\u2060d\u00ad.png', 'image/png')).toBe('abcd.png');
        expect(sanitizeFileName('\u200b\u200c', 'image/png')).toBe('image.png');
    });

    it('为空或只剩点时用默认名,过长时按字符截断', () => {
        expect(sanitizeFileName('', 'image/jpeg')).toBe('image.jpg');
        expect(sanitizeFileName('dir/..', 'image/webp')).toBe('image.webp');
        expect([...sanitizeFileName('图'.repeat(300), 'image/gif')]).toHaveLength(255);
    });
});

describe('schema', () => {
    it('附件 id 列表为 1–4 个且不重复', () => {
        expect(AttachmentIds.safeParse([ID_A, ID_B]).success).toBe(true);
        expect(AttachmentIds.safeParse([]).success).toBe(false);
        expect(AttachmentIds.safeParse([ID_A, ID_A]).success).toBe(false);
        expect(AttachmentIds.safeParse(Array.from({ length: 5 }, () => ID_A)).success).toBe(false);
    });

    it('附件元数据不接受超过 5 MiB 或非十六进制摘要', () => {
        const ok = {
            id: ID_A,
            messageId: null,
            mediaType: 'image/png',
            bytes: 1024,
            sha256: 'a'.repeat(64),
            fileName: 'x.png',
            createdAt: '2026-11-11T00:00:00.000Z',
        };
        expect(Attachment.safeParse(ok).success).toBe(true);
        expect(Attachment.safeParse({ ...ok, bytes: 5 * 1024 * 1024 + 1 }).success).toBe(false);
        expect(Attachment.safeParse({ ...ok, sha256: 'Z'.repeat(64) }).success).toBe(false);
        expect(Attachment.safeParse({ ...ok, mediaType: 'image/svg+xml' }).success).toBe(false);
    });
});

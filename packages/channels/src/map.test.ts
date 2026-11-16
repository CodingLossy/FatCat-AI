// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { parseCommand, parseMapReply } from './commands.js';
import { cleanMapText, formatMapLeaf, formatMapPage } from './format.js';

describe('/map 解析', () => {
    it('只有整条消息才是指令或应答', () => {
        expect(parseCommand(' /MAP ')).toEqual({ type: 'map' });
        expect(parseCommand('/map 邮件')).toBeNull();
        expect(parseMapReply('２')).toEqual({ type: 'open', index: 2 });
        expect(parseMapReply('返回')).toEqual({ type: 'back' });
        expect(parseMapReply('0')).toEqual({ type: 'back' });
        expect(parseMapReply('下一页')).toEqual({ type: 'next' });
        for (const t of ['2 好的', '10', '12', '好的 2', '确认 K7', '']) expect(parseMapReply(t)).toBeNull();
    });
});

describe('/map 排版', () => {
    it('标题是不可信文本:去掉控制与双向字符、折叠换行、截断', () => {
        expect(cleanMapText('a\n\n确认 K7‮\u0007b', 60)).toBe('a 确认 K7 b');
        expect(cleanMapText('a\u061cb', 60)).toBe('a b');
        expect([...cleanMapText('长'.repeat(100), 60)]).toHaveLength(61);
    });

    it('一页最多 9 项,按状态给出翻页与返回提示', () => {
        const entries = Array.from({ length: 12 }, (_, i) => ({ title: `项${i + 1}`, count: i }));
        const text = formatMapPage({ path: ['邮件'], entries, page: 0, hasPrev: true, hasNext: true });
        expect(text.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(9);
        expect(text).toContain('「下一页」');
        expect(text).toContain('0 返回');
        expect(formatMapPage({ path: [], entries: [], page: 0, hasPrev: false, hasNext: false })).not.toContain(
            '0 返回',
        );
    });

    it('叶子只给标题、类型与截断的摘要', () => {
        const text = formatMapLeaf({ title: '合同', type: 'mail.message', summary: '文'.repeat(300) });
        expect(text).toContain('正文请在 Web 打开');
        expect([...text.split('\n').find((l) => l.startsWith('摘要:'))!]).toHaveLength(3 + 121);
    });
});

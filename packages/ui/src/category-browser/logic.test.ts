// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { breadcrumbOf, crumbTo, expandAncestors, mergePage, toggleExpanded, virtualWindow } from './logic.js';

const rows = (ids: string[]) => ids.map((id) => ({ id, v: 1 }));

describe('mergePage', () => {
    it('分页合并不重复也不丢;重复项以新页为准并保持原位置', () => {
        const merged = mergePage(rows(['a', 'b']), [
            { id: 'b', v: 2 },
            { id: 'c', v: 1 },
        ]);
        expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
        expect(merged[1]!.v).toBe(2);
        expect(mergePage(merged, [])).toEqual(merged);
    });
});

describe('virtualWindow', () => {
    it('只渲染视口附近的行,占位高度正确,边界被夹住', () => {
        const base = { count: 1000, rowHeight: 40, viewportHeight: 400 };
        expect(virtualWindow({ ...base, scrollTop: 0, overscan: 2 })).toEqual({
            start: 0,
            end: 12,
            offsetTop: 0,
            totalHeight: 40000,
        });
        const mid = virtualWindow({ ...base, scrollTop: 4000, overscan: 2 });
        expect(mid).toMatchObject({ start: 98, end: 112, offsetTop: 3920 });
        // 滚过头:夹到最后一屏
        const end = virtualWindow({ ...base, scrollTop: 999999, overscan: 0 });
        expect(end.end).toBe(1000);
        expect(end.start).toBe(990);
        expect(virtualWindow({ ...base, count: 0, scrollTop: 0 })).toMatchObject({ start: 0, end: 0 });
        expect(virtualWindow({ ...base, count: 3, scrollTop: 0 }).end).toBe(3);
    });
});

describe('面包屑与展开状态', () => {
    it('面包屑切换回到那一层;展开状态不可变更新', () => {
        const trail = breadcrumbOf(
            [
                { id: '1', title: '小说' },
                { id: '2', title: '凡人' },
            ],
            { id: '3', title: '第一章' },
        );
        expect(trail.map((c) => c.title)).toEqual(['小说', '凡人', '第一章']);
        expect(crumbTo(trail, 1)).toEqual({ trail: trail.slice(0, 2), selectedId: '2' });
        expect(crumbTo(trail, -1)).toEqual({ trail: [], selectedId: null });
        const open = new Set(['1']);
        expect([...toggleExpanded(open, '2')]).toEqual(['1', '2']);
        expect([...toggleExpanded(open, '1')]).toEqual([]);
        expect([...open]).toEqual(['1']);
        expect([...expandAncestors(open, ['1', '2'])]).toEqual(['1', '2']);
        expect(breadcrumbOf([], null)).toEqual([]);
    });
});

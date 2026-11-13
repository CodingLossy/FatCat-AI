// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemCycleError, type ItemInput } from './items.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
beforeEach(async () => {
    t = await createTestDb({ now: fakeClock().auto() });
});
afterEach(() => t.cleanup());

const input = (ref: string, parentId: string | null, over: Partial<ItemInput> = {}): ItemInput => ({
    source: 'test',
    sourceRef: ref,
    kind: parentId ? 'content' : 'category',
    type: parentId ? 'test.leaf' : 'test.root',
    title: ref,
    parentId,
    ...over,
});

/** 用确定的伪随机数,失败时可以复现。 */
function rng(seed: number) {
    let x = seed;
    return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
    };
}

/** 默认展开能看到的内容条数:跳过 meta.hidden,内容节点计 1,再加上下面的。 */
function visibleContent(items: TestDb['repos']['items'], ownerId: string, id: string): number {
    let n = 0;
    let cursor: string | undefined;
    do {
        const page = items.children(ownerId, id, { limit: 50, sort: 'position', ...(cursor ? { cursor } : {}) });
        for (const child of page.items) {
            if ((child.meta as { hidden?: unknown } | null)?.hidden === true) continue;
            if (child.kind === 'content') n += 1;
            n += visibleContent(items, ownerId, child.id);
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return n;
}

describe('items:计数与树', () => {
    it('新建、移动、软删除、恢复时祖先计数正确;移动到自己的后代被拒绝', () => {
        const { items } = t.repos;
        const root = items.upsert(t.ownerId, input('root', null));
        const a = items.upsert(t.ownerId, input('a', root.id, { kind: 'category', type: 'test.folder' }));
        const b = items.upsert(t.ownerId, input('b', a.id));
        items.upsert(t.ownerId, input('c', a.id));
        expect(items.get(t.ownerId, root.id)).toMatchObject({ childCount: 1, descendantCount: 3 });
        expect(items.get(t.ownerId, a.id)).toMatchObject({ childCount: 2, descendantCount: 2 });

        const other = items.upsert(t.ownerId, input('other', null));
        items.upsert(t.ownerId, input('a', other.id, { kind: 'category', type: 'test.folder' }));
        expect(items.get(t.ownerId, root.id)).toMatchObject({ childCount: 0, descendantCount: 0 });
        expect(items.get(t.ownerId, other.id)).toMatchObject({ childCount: 1, descendantCount: 3 });
        expect(() => items.upsert(t.ownerId, input('other', b.id))).toThrow(ItemCycleError);
        expect(() => items.upsert(t.ownerId, input('a', a.id))).toThrow(ItemCycleError);

        expect(items.softDelete(t.ownerId, a.id)).toBe(true);
        expect(items.softDelete(t.ownerId, a.id)).toBe(false);
        expect(items.get(t.ownerId, other.id)).toMatchObject({ childCount: 0, descendantCount: 0 });
        expect(items.get(t.ownerId, b.id)?.deletedAt).not.toBeNull();
        // 恢复:父项先恢复,子项随后逐个恢复
        items.upsert(t.ownerId, input('a', other.id, { kind: 'category', type: 'test.folder' }));
        items.upsert(t.ownerId, input('b', a.id));
        expect(items.get(t.ownerId, other.id)).toMatchObject({ childCount: 1, descendantCount: 2 });
        expect(items.recount(t.ownerId)).toBe(0);
        expect(() => items.upsert(t.ownerId, input('x', 'NOPE'))).toThrow(/parent item does not exist/);
    });

    it('属性测试:随机新建 / 移动 / 软删除 / 恢复之后,计数与递归计算一致,树无环', () => {
        const { items } = t.repos;
        const random = rng(42);
        const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
        const refs: string[] = [];
        const root = items.upsert(t.ownerId, input('root', null));
        for (let step = 0; step < 400; step++) {
            const live = [
                root.id,
                ...refs
                    .map((r) => items.bySource(t.ownerId, 'test', r)!)
                    .filter((i) => !i.deletedAt)
                    .map((i) => i.id),
            ];
            const op = random();
            try {
                if (op < 0.5 || refs.length < 5) {
                    const ref = `n${step}`;
                    items.upsert(t.ownerId, input(ref, pick(live), { kind: 'category' }));
                    refs.push(ref);
                } else if (op < 0.75) {
                    const ref = pick(refs);
                    const item = items.bySource(t.ownerId, 'test', ref)!;
                    if (!item.deletedAt) items.upsert(t.ownerId, input(ref, pick(live), { kind: 'category' }));
                } else if (op < 0.9) {
                    items.softDelete(t.ownerId, pick(live.slice(1).length ? live.slice(1) : live));
                } else {
                    const ref = pick(refs);
                    if (items.bySource(t.ownerId, 'test', ref)!.deletedAt) {
                        items.upsert(t.ownerId, input(ref, pick(live), { kind: 'category' }));
                    }
                }
            } catch (error) {
                // 移动到自己的后代被拒绝:属于预期,状态不应改变
                expect(error).toBeInstanceOf(ItemCycleError);
            }
        }
        expect(items.recount(t.ownerId)).toBe(0);
        // 无环:每个条目的祖先链有限且不重复
        for (const ref of refs) {
            const item = items.bySource(t.ownerId, 'test', ref)!;
            const chain = items.ancestors(t.ownerId, item.id).map((a) => a.id);
            expect(new Set(chain).size).toBe(chain.length);
            expect(chain).not.toContain(item.id);
        }
    });

    it('每一层的 contentCount 等于默认展开能看到的内容条数', () => {
        const { items } = t.repos;
        const root = items.upsert(t.ownerId, input('root', null, { kind: 'category', type: 'test.root' }));
        const folder = items.upsert(t.ownerId, input('folder', root.id, { kind: 'category', type: 'test.folder' }));
        items.upsert(t.ownerId, input('leaf', folder.id));
        items.upsert(t.ownerId, input('leaf-2', folder.id));
        const hidden = items.upsert(
            t.ownerId,
            input('history', folder.id, { kind: 'category', type: 'test.history', meta: { hidden: true } }),
        );
        items.upsert(t.ownerId, input('old', hidden.id));
        const check = (id: string) => {
            const item = items.get(t.ownerId, id)!;
            expect(item.contentCount).toBe(visibleContent(items, t.ownerId, id));
        };
        check(root.id);
        check(folder.id);
        check(hidden.id);
        expect(items.get(t.ownerId, root.id)?.contentCount).toBe(2);
        expect(items.get(t.ownerId, folder.id)?.contentCount).toBe(2);
        expect(items.get(t.ownerId, hidden.id)?.contentCount).toBe(1);
    });

    it('recount 修正被破坏的计数', () => {
        const { items } = t.repos;
        const root = items.upsert(t.ownerId, input('root', null));
        items.upsert(t.ownerId, input('a', root.id));
        t.conn.sqlite.prepare('UPDATE items SET child_count = 9, descendant_count = 9 WHERE id = ?').run(root.id);
        expect(items.recount(t.ownerId)).toBe(1);
        expect(items.get(t.ownerId, root.id)).toMatchObject({ childCount: 1, descendantCount: 1 });
    });
});

describe('items:查询', () => {
    it('roots、children 分页与排序、ancestors、counts、subtree、search、changes、removeMissing', () => {
        const { items } = t.repos;
        const root = items.upsert(t.ownerId, input('小说', null, { title: '小说', type: 'novels.root' }));
        const book = items.upsert(
            t.ownerId,
            input('book', root.id, { kind: 'category', type: 'novel', title: '三体' }),
        );
        for (let i = 0; i < 5; i++) {
            items.upsert(
                t.ownerId,
                input(`ch${i}`, book.id, { type: 'novel.chapter', title: `第${i + 1}章 标题${i}`, position: i }),
            );
        }
        items.upsert(t.ownerId, { ...input('memory', null), source: 'memory' });
        // 记忆自 M2 PR 14 起有自己的提供者,根类别出现在 roots 中(ADR 0007 第 5.8 节)
        expect(items.roots(t.ownerId).map((r) => r.title)).toEqual(['memory', '小说']);

        const first = items.children(t.ownerId, book.id, { limit: 2, sort: 'position' });
        const second = items.children(t.ownerId, book.id, { limit: 2, sort: 'position', cursor: first.nextCursor! });
        const third = items.children(t.ownerId, book.id, { limit: 2, sort: 'position', cursor: second.nextCursor! });
        expect([...first.items, ...second.items, ...third.items].map((i) => i.sourceRef)).toEqual([
            'ch0',
            'ch1',
            'ch2',
            'ch3',
            'ch4',
        ]);
        expect(third.nextCursor).toBeNull();
        expect(items.children(t.ownerId, book.id, { limit: 10, sort: 'updatedAt' }).items[0]?.sourceRef).toBe('ch4');
        expect(items.children(t.ownerId, root.id, { limit: 10, sort: 'title', kind: 'content' }).items).toEqual([]);

        const chapter = items.bySource(t.ownerId, 'test', 'ch2')!;
        expect(items.ancestors(t.ownerId, chapter.id).map((a) => a.title)).toEqual(['小说', '三体']);
        expect(items.ancestors(t.ownerId, 'missing')).toEqual([]);
        expect(items.counts(t.ownerId, root.id)).toEqual({
            children: 1,
            descendants: 6,
            byType: { novel: 1, 'novel.chapter': 5 },
        });
        expect(items.subtree(t.ownerId, root.id, 2, 3).nodes.map((n) => [n.item.title, n.depth])).toEqual([
            ['三体', 1],
            ['第1章 标题0', 2],
            ['第2章 标题1', 2],
            ['第3章 标题2', 2],
        ]);

        expect(items.search(t.ownerId, { q: '标题3', limit: 10 }).map((i) => i.sourceRef)).toEqual(['ch3']);
        expect(items.search(t.ownerId, { q: '三体', limit: 10, under: root.id }).map((i) => i.sourceRef)).toEqual([
            'book',
        ]);
        expect(items.search(t.ownerId, { q: '标题', limit: 10, type: 'novel' })).toEqual([]);

        expect(items.removeMissing(t.ownerId, book.id, 'test', new Set(['ch0', 'ch1']))).toBe(3);
        expect(items.get(t.ownerId, book.id)).toMatchObject({ childCount: 2, descendantCount: 2 });
        const changes = items.changes(t.ownerId, { limit: 100 });
        expect(
            changes.items
                .filter((i) => i.deletedAt)
                .map((i) => i.sourceRef)
                .sort(),
        ).toEqual(['ch2', 'ch3', 'ch4']);
        expect(changes.items.some((i) => i.source === 'memory')).toBe(false);
        const paged = items.changes(t.ownerId, { limit: 3 });
        expect(items.changes(t.ownerId, { limit: 100, cursor: paged.nextCursor! }).items).toHaveLength(
            changes.items.length - 3,
        );
        expect(items.counts(t.ownerId, 'missing')).toBeNull();
    });
});

describe('kb.reassign', () => {
    it('moves kb_sources and kb_chunks to the new item and leaves nothing on the old one', () => {
        const { repos, ownerId } = t;
        const from = repos.items.upsert(ownerId, input('old', null));
        const to = repos.items.upsert(ownerId, input('new', null));
        repos.kb.replace(ownerId, { itemId: from.id, mtime: null, size: 3, chunkChars: 100 }, [
            { page: null, heading: null, text: 'hello' },
        ]);
        repos.kb.reassign(from.id, to.id);
        expect(repos.kb.source(from.id)).toBeNull();
        expect(repos.kb.source(to.id)?.chunks).toBe(1);
        expect(repos.kb.get(ownerId, to.id, 0)?.text).toBe('hello');
    });

    it('does not overwrite data already indexed on the target', () => {
        const { repos, ownerId } = t;
        const from = repos.items.upsert(ownerId, input('old', null));
        const to = repos.items.upsert(ownerId, input('new', null));
        const file = (itemId: string) => ({ itemId, mtime: null, size: 1, chunkChars: 100 });
        repos.kb.replace(ownerId, file(from.id), [{ page: null, heading: null, text: 'old' }]);
        repos.kb.replace(ownerId, file(to.id), [{ page: null, heading: null, text: 'new' }]);
        repos.kb.reassign(from.id, to.id);
        expect(repos.kb.get(ownerId, to.id, 0)?.text).toBe('new');
    });
});

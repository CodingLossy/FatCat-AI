// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识视图的数据映射(纯函数):把记忆和条目接口的返回值变成主视觉的节点。接口和数据都不改,只读。
import type { Item, Memory, MemoryConflict, MemType } from '@fatcat-ai/shared';
import { firstSentence, type KnowledgeNode, orderNodes } from '@fatcat-ai/ui';

export const MEM_TYPES: readonly MemType[] = ['semantic', 'episodic', 'procedural'];

/** 节点 id 前缀:t 记忆类别、m 一条记忆、i 一个条目。 */
export const typeId = (t: MemType) => `t:${t}`;
export const memoryId = (id: string) => `m:${id}`;
export const itemId = (id: string) => `i:${id}`;

export type NodeRef =
    { kind: 'type'; memType: MemType } | { kind: 'memory'; id: string } | { kind: 'item'; id: string };

export function parseNodeId(id: string): NodeRef | null {
    const [prefix, rest] = [id.slice(0, 2), id.slice(2)];
    if (!rest) return null;
    if (prefix === 't:' && (MEM_TYPES as readonly string[]).includes(rest))
        return { kind: 'type', memType: rest as MemType };
    if (prefix === 'm:') return { kind: 'memory', id: rest };
    if (prefix === 'i:') return { kind: 'item', id: rest };
    return null;
}

/** 正在冲突中的记忆 id(只算未解决的)。 */
export function conflictIds(conflicts: readonly MemoryConflict[]): Set<string> {
    const out = new Set<string>();
    for (const c of conflicts) {
        if (c.status !== 'open') continue;
        out.add(c.a.id);
        out.add(c.b.id);
    }
    return out;
}

export function memoryNodes(
    memories: readonly Memory[],
    memType: MemType,
    conflicts: ReadonlySet<string>,
    pinned: ReadonlySet<string>,
): KnowledgeNode[] {
    return orderNodes(
        memories
            .filter((m) => m.memType === memType)
            .map((m) => ({
                id: memoryId(m.id),
                label: firstSentence(m.text, 40),
                kind: 'leaf' as const,
                conflict: conflicts.has(m.id),
                pinned: pinned.has(memoryId(m.id)) || m.pinned === true,
            })),
        Number.MAX_SAFE_INTEGER,
    );
}

export function itemNodes(
    items: readonly Item[],
    pinned: ReadonlySet<string>,
    title: (i: Item) => string,
): KnowledgeNode[] {
    return orderNodes(
        items.map((i) => ({
            id: itemId(i.id),
            label: title(i),
            kind: i.kind === 'category' && i.childCount > 0 ? ('branch' as const) : ('leaf' as const),
            pinned: pinned.has(itemId(i.id)),
        })),
        Number.MAX_SAFE_INTEGER,
    );
}

const PIN_KEY = 'fatcat.knowledge.pinned';

/** 置顶只记在本机(接口没有置顶字段,不改数据)。读写失败时当作没有置顶。 */
export function loadPinned(): Set<string> {
    try {
        const raw = window.localStorage.getItem(PIN_KEY);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
    } catch {
        return new Set();
    }
}

export function savePinned(pinned: ReadonlySet<string>): void {
    try {
        window.localStorage.setItem(PIN_KEY, JSON.stringify([...pinned]));
    } catch {
        // 存不下就只在本次会话有效
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Memory, MemoryConflict } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { conflictIds, memoryNodes, parseNodeId } from './knowledge-data.js';

const mem = (id: string, memType: Memory['memType'], text: string) => ({ id, memType, text }) as Memory;

describe('knowledge data', () => {
    it('节点 id 能解析回记忆类别、记忆和条目;未知前缀为 null', () => {
        expect(parseNodeId('t:semantic')).toEqual({ kind: 'type', memType: 'semantic' });
        expect(parseNodeId('m:abc')).toEqual({ kind: 'memory', id: 'abc' });
        expect(parseNodeId('i:xyz')).toEqual({ kind: 'item', id: 'xyz' });
        expect(parseNodeId('t:nope')).toBeNull();
        expect(parseNodeId('x:1')).toBeNull();
    });

    it('只把未解决的冲突标红;记忆按类别过滤,置顶排前', () => {
        const conflicts = conflictIds([
            { status: 'open', a: { id: 'a' }, b: { id: 'b' } },
            { status: 'dismissed', a: { id: 'c' }, b: { id: 'd' } },
        ] as MemoryConflict[]);
        expect([...conflicts].sort()).toEqual(['a', 'b']);
        const nodes = memoryNodes(
            [mem('a', 'semantic', '甲。'), mem('c', 'semantic', '丙。'), mem('e', 'episodic', '戊。')],
            'semantic',
            conflicts,
            new Set(['m:c']),
        );
        expect(nodes.map((n) => n.id)).toEqual(['m:c', 'm:a']);
        expect(nodes.find((n) => n.id === 'm:a')?.conflict).toBe(true);
    });
});

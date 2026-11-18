// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    forkForest,
    memoryAlpha,
    memoryLayout,
    MEMORY_COLORS,
    nextMapNode,
    pickMapNode,
    type MemoryLike,
    type SessionLike,
} from './logic.js';

const mem = (i: number, over: Partial<MemoryLike> = {}): MemoryLike => ({
    id: `m${i}`,
    text: `memory ${i}`,
    memType: ['semantic', 'episodic', 'procedural'][i % 3]!,
    status: 'active',
    confidence: 0.9,
    ...over,
});

describe('memoryLayout', () => {
    it('clusters by type, colours by type and keeps every point inside the canvas', () => {
        const layout = memoryLayout(Array.from({ length: 90 }, (_, i) => mem(i)));
        expect(layout.groups.map((g) => g.key).sort()).toEqual(['episodic', 'procedural', 'semantic']);
        expect(layout.nodes).toHaveLength(90);
        for (const n of layout.nodes) {
            expect(n.x).toBeGreaterThanOrEqual(0);
            expect(n.x).toBeLessThanOrEqual(1);
            expect(n.y).toBeGreaterThanOrEqual(0);
            expect(n.y).toBeLessThanOrEqual(1);
        }
        expect(layout.nodes.find((n) => n.id === 'm0')!.color).toBe(MEMORY_COLORS['semantic']);
    });

    it('outlines conflicted memories, from status or from the open-conflict set', () => {
        const layout = memoryLayout([mem(0), mem(1, { status: 'conflicted' }), mem(2)], new Set(['m2']));
        const outline = (id: string) => layout.nodes.find((n) => n.id === id)!.outline;
        expect([outline('m0'), outline('m1'), outline('m2')]).toEqual([false, true, true]);
    });

    it('is bright for confident active memories and dim for cold, superseded ones', () => {
        const bright = memoryAlpha({ confidence: 1, tier: 'active', pinned: false, status: 'active' });
        const dim = memoryAlpha({ confidence: 0.3, tier: 'archive', pinned: false, status: 'active' });
        expect(bright).toBeGreaterThan(dim);
        expect(memoryAlpha({ confidence: 1, tier: 'active', pinned: true, status: 'superseded' })).toBeLessThanOrEqual(
            0.25,
        );
        expect(memoryAlpha({ confidence: 0, tier: 'archive', pinned: true, status: 'active' })).toBeGreaterThanOrEqual(
            0.8,
        );
    });

    it('handles an empty list and a single cluster', () => {
        expect(memoryLayout([]).nodes).toEqual([]);
        expect(memoryLayout([mem(0), mem(3)]).groups).toHaveLength(1);
    });
});

const sess = (id: string, parent: string | null = null): SessionLike => ({
    id,
    title: id,
    forkedFromSessionId: parent,
    forkedFromMessageId: parent ? `msg-${id}` : null,
});

describe('forkForest', () => {
    it('lays forks out below their parent and draws one edge per fork', () => {
        const layout = forkForest([sess('a'), sess('b', 'a'), sess('c', 'a'), sess('d', 'b'), sess('solo')]);
        expect(layout.standalone).toBe(1);
        expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
        const y = (id: string) => layout.nodes.find((n) => n.id === id)!.y;
        expect(y('b')).toBeGreaterThan(y('a'));
        expect(y('d')).toBeGreaterThan(y('b'));
        expect(layout.edges).toEqual(
            expect.arrayContaining([
                { from: 'a', to: 'b' },
                { from: 'a', to: 'c' },
                { from: 'b', to: 'd' },
            ]),
        );
        expect(layout.edges).toHaveLength(3);
    });

    it('treats a fork whose parent is missing as a root and survives a cycle', () => {
        const orphan = forkForest([sess('x', 'gone')]);
        expect(orphan.nodes).toHaveLength(1);
        expect(orphan.edges).toEqual([]);
        const cycle = forkForest([sess('p', 'q'), sess('q', 'p')]);
        expect(cycle.nodes.length).toBeLessThanOrEqual(2);
    });
});

describe('picking and keyboard', () => {
    const layout = forkForest([sess('a'), sess('b', 'a'), sess('c', 'a')]);
    it('picks the node under the pointer and nothing in empty space', () => {
        const a = layout.nodes.find((n) => n.id === 'a')!;
        expect(pickMapNode(layout.nodes, 400, a.x * 400, a.y * 400)).toBe('a');
        expect(pickMapNode(layout.nodes, 400, 2, 2)).toBeNull();
    });

    it('moves down from the parent to a child and stays put when nothing lies that way', () => {
        const down = nextMapNode(layout.nodes, 'a', 'down')!;
        expect(['b', 'c']).toContain(down);
        expect(nextMapNode(layout.nodes, 'a', 'up')).toBe('a');
        expect(nextMapNode(layout.nodes, null, 'down')).not.toBeNull();
    });
});

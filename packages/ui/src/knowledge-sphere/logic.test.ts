// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { layoutNodes, neighbor, pickNode, project, rotationToFront, shouldUseList, type SphereItem } from './logic.js';

const items = (n: number): SphereItem[] =>
    Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}`, weight: i, category: i % 2 === 0 }));
const view = { yaw: 0, pitch: 0, size: 400 };

describe('layout and projection', () => {
    it('places every item on the unit sphere and keeps order', () => {
        const nodes = layoutNodes(items(50));
        expect(nodes.map((n) => n.id)).toEqual(items(50).map((i) => i.id));
        for (const n of nodes) expect(Math.hypot(...n.pos)).toBeCloseTo(1, 6);
    });

    it('projects inside the canvas, and rotation moves points', () => {
        const nodes = layoutNodes(items(200));
        for (const p of project(nodes, view)) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(400);
        }
        const a = project(nodes, view)[3]!;
        const b = project(nodes, { ...view, yaw: 1 })[3]!;
        expect(a.x === b.x && a.y === b.y).toBe(false);
    });
});

describe('picking and keyboard', () => {
    const nodes = layoutNodes(items(120));
    const projected = project(nodes, view);

    it('picks the front-facing point under the pointer and ignores the back side', () => {
        const front = projected.find((p) => p.depth > 0.5)!;
        expect(pickNode(projected, front.x, front.y)).toBe(front.id);
        const back = projected.filter((p) => p.depth < -0.5)[0]!;
        const hit = pickNode(projected, back.x, back.y);
        expect(hit === null || projected.find((p) => p.id === hit)!.depth >= 0).toBe(true);
        expect(pickNode(projected, -50, -50)).toBeNull();
    });

    it('moves the selection in the arrow direction and never to the back', () => {
        const start = neighbor(projected, null, 'right')!;
        const startP = projected.find((p) => p.id === start)!;
        const next = neighbor(projected, start, 'right')!;
        const nextP = projected.find((p) => p.id === next)!;
        expect(nextP.depth).toBeGreaterThanOrEqual(0);
        expect(nextP.x).toBeGreaterThanOrEqual(startP.x);
    });

    it('rotationToFront brings a back point to the front', () => {
        const node = nodes.find((n) => n.pos[2] < -0.6)!;
        const rot = rotationToFront(node.pos);
        const p = project([node], { ...rot, size: 400 })[0]!;
        expect(p.depth).toBeGreaterThan(0.5);
    });
});

describe('fallback', () => {
    it('uses the list without canvas or with reduced motion', () => {
        expect(shouldUseList({ canvasAvailable: false, reducedMotion: false })).toBe(true);
        expect(shouldUseList({ canvasAvailable: true, reducedMotion: true })).toBe(true);
        expect(shouldUseList({ canvasAvailable: true, reducedMotion: false })).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    STARS_PER_CONSTELLATION,
    starLift,
    TECH_CONSTELLATIONS,
    techConstellations,
    techLook,
    techStars,
} from './heroes/tech-model.js';
import {
    branchChain,
    climbGlow,
    natureLook,
    natureTree,
    swayOffset,
    tipsFor,
    TREE_BASE,
} from './heroes/nature-model.js';
import { clusterCenter } from './heroes/anchored-knowledge.js';
import {
    catPose,
    catStrokes,
    EAR_L_PIVOT,
    flowGlow,
    outlineAnchors,
    posePoint,
    TAIL_PIVOT,
} from './heroes/cat-model.js';
import { DEFAULT_THEME, resolveTheme } from './theme-ids.js';

describe('resolveTheme', () => {
    it('旧值、未知值和还没做好的主题一律按科技处理;科技本身保持', () => {
        for (const old of ['system', 'light', 'dark', 'obsidian', 'nebula', '', null, undefined, 3]) {
            expect(resolveTheme(old)).toBe(DEFAULT_THEME);
        }
        expect(resolveTheme('tech')).toBe('tech');
        expect(resolveTheme('nature')).toBe('nature');
        expect(resolveTheme('cat')).toBe('cat');
        expect(DEFAULT_THEME).toBe('tech');
    });
});

describe('tech hero model', () => {
    it('星点和星座固定种子可复现,星座点都在单位球面上', () => {
        expect(techStars(50)).toEqual(techStars(50));
        const stars = techStars(2000);
        const share = (c: number) => stars.filter((s) => s.color === c).length / stars.length;
        expect(share(0)).toBeGreaterThan(0.65);
        expect(share(1)).toBeGreaterThan(0.08);
        expect(share(2)).toBeGreaterThan(0.08);
        const groups = techConstellations();
        expect(groups).toHaveLength(TECH_CONSTELLATIONS);
        for (const g of groups) {
            expect(g.points).toHaveLength(STARS_PER_CONSTELLATION);
            for (const [x, y, z] of g.points) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
        }
    });

    it('聆听偏青、思考偏紫且转得更快,说话时星点随音量起伏,知识模式整体压暗', () => {
        expect(techLook('listening', false).tintColor).toBe(2);
        expect(techLook('thinking', false).tintColor).toBe(1);
        expect(techLook('thinking', false).spin).toBeGreaterThan(techLook('listening', false).spin);
        expect(techLook('idle', false).tintAmount).toBe(0);
        expect(techLook('idle', true).brightness).toBeLessThan(techLook('idle', false).brightness);
        expect(starLift('speaking', 0, 1, 1)).toBe(0);
        expect(Math.abs(starLift('speaking', 1, 0.5, 0.3))).toBeGreaterThan(0);
        expect(starLift('listening', 1, 0.5, 0.3)).toBe(0);
    });
});

describe('nature hero model', () => {
    const tree = natureTree();

    it('树固定种子可复现,主干从树根往上长,枝头按角度排好', () => {
        expect(natureTree().branches).toEqual(tree.branches);
        const trunk = tree.branches[0]!;
        expect(trunk.parent).toBe(-1);
        expect(trunk.y1).toBeLessThan(trunk.y0);
        expect(tree.tips.length).toBeGreaterThan(20);
        expect(tree.canopyDots.length).toBeGreaterThan(1000);
        for (const d of [...tree.trunkDots, ...tree.canopyDots]) {
            expect(Math.abs(d.x)).toBeLessThan(1.05);
            expect(d.y).toBeLessThan(1);
            expect(d.y).toBeGreaterThan(-1);
        }
        const angle = (i: number) => {
            const b = tree.branches[i]!;
            return Math.atan2(b.y1 - TREE_BASE.y, b.x1 - TREE_BASE.x);
        };
        for (let k = 1; k < tree.tips.length; k++)
            expect(angle(tree.tips[k]!)).toBeGreaterThanOrEqual(angle(tree.tips[k - 1]!));
    });

    it('枝链从主干开始、路程递增;第一层节点分到不同枝头', () => {
        const tip = tree.tips[5]!;
        const chain = branchChain(tree, tip);
        expect(chain[0]).toBe(0);
        expect(chain.at(-1)).toBe(tip);
        for (let k = 1; k < chain.length; k++) {
            expect(tree.branches[chain[k]!]!.h0).toBeCloseTo(tree.branches[chain[k - 1]!]!.h1, 9);
        }
        const six = tipsFor(tree, 6);
        expect(new Set(six).size).toBe(6);
        expect(tipsFor(tree, 0)).toEqual([]);
    });

    it('说话时随音量摇、思考时光往上爬,树根不动;知识模式压暗', () => {
        expect(natureLook('speaking', 1, false).sway).toBeGreaterThan(natureLook('speaking', 0, false).sway);
        expect(natureLook('thinking', 0, false).climb).toBeGreaterThan(0);
        expect(natureLook('idle', 0, false).climb).toBe(0);
        expect(natureLook('idle', 0, true).brightness).toBeLessThan(natureLook('idle', 0, false).brightness);
        expect(Math.abs(swayOffset(TREE_BASE.y, 0.05, 1.3))).toBe(0);
        expect(Math.abs(swayOffset(-0.8, 0.05, 1.3))).toBeGreaterThan(0);
        expect(climbGlow(0.5, 0, 3)).toBe(0);
        expect(climbGlow(0.2, 0.45, 0.25 / 0.45)).toBeGreaterThan(0.5);
    });

    it('叶簇中心留在画布里', () => {
        const c = clusterCenter({ x: 5, y: 5 }, { x: 200, y: 400 }, 200, 400, 400);
        expect(c.x).toBeGreaterThan(0);
        expect(c.y).toBeGreaterThan(0);
    });
});

describe('cat hero model', () => {
    const strokes = catStrokes();

    it('线稿有头、两只耳朵、身子、尾巴和脸,点都在 [-1, 1] 里', () => {
        const parts = new Set(strokes.map((s) => s.part));
        for (const p of ['head', 'earL', 'earR', 'body', 'tail', 'face']) expect(parts.has(p as never)).toBe(true);
        for (const s of strokes) {
            for (const [x, y] of s.points) {
                expect(Math.abs(x)).toBeLessThanOrEqual(1);
                expect(Math.abs(y)).toBeLessThanOrEqual(1);
            }
        }
    });

    it('聆听时耳朵动、思考时尾巴摆、说话时光流动且随音量变快;知识模式静下来', () => {
        const ears = Array.from({ length: 40 }, (_, k) => catPose('listening', 0, k * 0.05, false).earL);
        expect(Math.max(...ears)).toBeGreaterThan(0.1);
        expect(catPose('idle', 0, 0.3, false).earL).toBe(0);
        const tails = Array.from({ length: 40 }, (_, k) => Math.abs(catPose('thinking', 0, k * 0.05, false).tail));
        expect(Math.max(...tails)).toBeGreaterThan(0.25);
        expect(catPose('speaking', 1, 0, false).flowSpeed).toBeGreaterThan(catPose('speaking', 0, 0, false).flowSpeed);
        expect(catPose('idle', 0, 0, false).flow).toBe(0);
        expect(catPose('speaking', 1, 0, true).flow).toBe(0);
        expect(flowGlow(0.5, 0, 1)).toBe(0);
        expect(flowGlow(0.25, 0.25, 1)).toBe(1);
    });

    it('耳朵绕耳根、尾巴绕尾根转,支点自己不动', () => {
        const pose = { earL: 0.3, earR: 0, tail: 0.4, breathe: 0, flow: 0, flowSpeed: 0, brightness: 1 };
        const pivot = posePoint('earL', EAR_L_PIVOT, pose);
        expect(pivot[0]).toBeCloseTo(EAR_L_PIVOT[0], 9);
        expect(pivot[1]).toBeCloseTo(EAR_L_PIVOT[1], 9);
        const tip = posePoint('tail', TAIL_PIVOT, pose);
        expect(tip[0]).toBeCloseTo(TAIL_PIVOT[0], 9);
        expect(tip[1]).toBeCloseTo(TAIL_PIVOT[1], 9);
        expect(posePoint('earL', [-0.34, -0.9], pose)).not.toEqual([-0.34, -0.9]);
    });

    it('第一层节点均匀挂在轮廓上(不在脸上),位置互不相同', () => {
        const a = outlineAnchors(strokes, 8);
        expect(a).toHaveLength(8);
        expect(new Set(a.map((x) => `${x.stroke}:${x.index}`)).size).toBe(8);
        for (const x of a) expect(['face', 'legs']).not.toContain(strokes[x.stroke]!.part);
        expect(outlineAnchors(strokes, 0)).toEqual([]);
    });
});

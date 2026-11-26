// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    speakBrightness,
    STARS_PER_CONSTELLATION,
    starLift,
    stepSpeakGlow,
    TECH_CONSTELLATIONS,
    techConstellations,
    techLook,
    techStars,
} from './heroes/tech-model.js';
import {
    branchChain,
    climbGlow,
    createLeafField,
    LEAF_CAP,
    LEAF_CAP_PHONE,
    LEAF_LINGER_MS,
    leafAlpha,
    leafCap,
    natureLook,
    natureTree,
    stepLeaves,
    swayOffset,
    tipsFor,
    TREE_BASE,
} from './heroes/nature-model.js';
import { clusterCenter } from './heroes/anchored-knowledge.js';
import {
    bubbleOpacity,
    CAT_FACE,
    catMouth,
    catPose,
    catStrokes,
    createBubbles,
    EAR_L_PIVOT,
    flowGlow,
    outlineAnchors,
    posePoint,
    stepBubbles,
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
        // 思考换一种转法:反向自转并且球轴摆动,比聆听转得快
        expect(techLook('thinking', false).spin).toBeLessThan(0);
        expect(Math.abs(techLook('thinking', false).spin)).toBeGreaterThan(techLook('listening', false).spin);
        expect(techLook('thinking', false).wobble).toBeGreaterThan(0);
        expect(techLook('listening', false).wobble).toBe(0);
        expect(techLook('idle', true).brightness).toBeLessThan(techLook('idle', false).brightness);
        expect(starLift('speaking', 0, 1, 1)).toBe(0);
        expect(Math.abs(starLift('speaking', 1, 0.5, 0.3))).toBeGreaterThan(0);
        // 说话时只向外脉动
        for (let t = 0; t < 3; t += 0.1) expect(starLift('speaking', 1, 0.5, t)).toBeGreaterThan(0);
        expect(starLift('listening', 1, 0.5, 0.3)).toBe(0);
    });

    it('说话时亮度平滑跟着音量,一步不会跳满,结束后缓回;减少动态不亮', () => {
        const step = stepSpeakGlow(0, 1, true, 16, false);
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThan(0.15);
        let glow = 1;
        for (let i = 0; i < 40; i++) glow = stepSpeakGlow(glow, null, false, 50, false);
        expect(glow).toBeLessThan(0.05);
        expect(stepSpeakGlow(0.8, 1, true, 16, true)).toBe(0);
        expect(speakBrightness(1, 1)).toBeGreaterThan(speakBrightness(1, 0));
        expect(speakBrightness(0.75, 0)).toBeCloseTo(0.75);
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

    it('落叶按音量一片一片出现,到底淡出并回收,手机更少,说话停几秒后不再落', () => {
        expect(leafAlpha(0.2)).toBe(1);
        expect(leafAlpha(0.7)).toBeGreaterThan(0);
        expect(leafAlpha(0.7)).toBeLessThan(1);
        expect(leafAlpha(0.97)).toBe(0);
        expect(leafCap(true)).toBe(LEAF_CAP_PHONE);
        expect(leafCap(false)).toBe(LEAF_CAP);

        const run = (level: number, cap: number, ms: number, speaking = true) => {
            let field = createLeafField(11);
            const steps = Math.ceil(ms / 50);
            for (let i = 0; i < steps; i++) field = stepLeaves(field, 50, speaking, level, cap, false);
            return field;
        };
        const loud = run(1, LEAF_CAP, 2000);
        const quiet = run(0.12, LEAF_CAP, 2000);
        const phone = run(1, LEAF_CAP_PHONE, 6000);
        const active = (field: typeof loud) => field.leaves.filter((leaf) => leaf.active).length;
        expect(active(loud)).toBeGreaterThan(active(quiet));
        expect(loud.leaves.length).toBeLessThanOrEqual(LEAF_CAP);
        expect(phone.leaves.length).toBeLessThanOrEqual(LEAF_CAP_PHONE);
        expect(active(phone)).toBeLessThanOrEqual(LEAF_CAP_PHONE);
        // 同一颗种子、同样的步数,结果一样
        expect(run(0.8, LEAF_CAP, 2000).leaves).toEqual(run(0.8, LEAF_CAP, 2000).leaves);
        // 说话停下的头一段,旧叶子还在落,但没有新出生的
        let falling = run(1, LEAF_CAP, 1000);
        falling = stepLeaves(falling, 50, false, 0, LEAF_CAP, false);
        for (let i = 0; i < 3; i++) falling = stepLeaves(falling, 50, false, 1, LEAF_CAP, false);
        expect(falling.leaves.some((leaf) => leaf.active)).toBe(true);
        expect(falling.leaves.filter((leaf) => leaf.active && leaf.age < 0.15)).toEqual([]);
        // 几秒之后落叶停干净
        for (let i = 0; i < Math.ceil(LEAF_LINGER_MS / 50) + 2; i++) {
            falling = stepLeaves(falling, 50, false, 1, LEAF_CAP, false);
        }
        expect(falling.leaves.every((leaf) => !leaf.active)).toBe(true);
        // 淡出后回收,池子不继续变长
        let faded = createLeafField(1);
        faded = {
            ...faded,
            leaves: [
                {
                    active: true,
                    x: 0,
                    y: 0.97,
                    vx: 0,
                    vy: 0.2,
                    phase: 0,
                    size: 1,
                    age: 0.2,
                },
            ],
        };
        faded = stepLeaves(faded, 50, false, 0, LEAF_CAP, false);
        expect(faded.leaves[0]?.active).toBe(false);
        expect(faded.leaves).toHaveLength(1);
        // 减少动态:正在落的也清掉
        const cleared = stepLeaves(loud, 16, true, 1, LEAF_CAP, true);
        expect(cleared.leaves.every((leaf) => !leaf.active)).toBe(true);
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
        expect(catPose('speaking', 1, 0.2, false).mouth).toBeGreaterThan(catPose('speaking', 0, 0.2, false).mouth);
        expect(catPose('idle', 0, 0.3, false).mouth).toBe(0);
        expect(catPose('speaking', 1, 0.4, true).mouth).toBe(0);
        const speakEars = Array.from({ length: 40 }, (_, k) => Math.abs(catPose('speaking', 1, k * 0.05, false).earL));
        expect(Math.max(...speakEars)).toBeGreaterThan(0.02);
        expect(Math.max(...speakEars)).toBeLessThan(0.2);
        const speakTails = Array.from({ length: 40 }, (_, k) => Math.abs(catPose('speaking', 1, k * 0.05, false).tail));
        expect(Math.max(...speakTails)).toBeGreaterThan(0.08);
        expect(Math.max(...speakTails)).toBeLessThan(0.25);
        expect(catMouth(0)).toEqual([]);
        const open = catMouth(1);
        const ys = open.map((p) => p[1]);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.08);
        expect(flowGlow(0.5, 0, 1)).toBe(0);
        expect(flowGlow(0.25, 0.25, 1)).toBe(1);
    });

    it('耳朵绕耳根、尾巴绕尾根转,支点自己不动', () => {
        const pose = { earL: 0.3, earR: 0, tail: 0.4, breathe: 0, flow: 0, flowSpeed: 0, brightness: 1, mouth: 0 };
        const pivot = posePoint('earL', EAR_L_PIVOT, pose);
        expect(pivot[0]).toBeCloseTo(EAR_L_PIVOT[0], 9);
        expect(pivot[1]).toBeCloseTo(EAR_L_PIVOT[1], 9);
        const tip = posePoint('tail', TAIL_PIVOT, pose);
        expect(tip[0]).toBeCloseTo(TAIL_PIVOT[0], 9);
        expect(tip[1]).toBeCloseTo(TAIL_PIVOT[1], 9);
        expect(posePoint('earL', [-0.34, -0.9], pose)).not.toEqual([-0.34, -0.9]);
    });

    it('第一层节点均匀挂在身子和尾巴上,避开脸和胡须,位置互不相同', () => {
        const a = outlineAnchors(strokes, 8);
        expect(a).toHaveLength(8);
        expect(new Set(a.map((x) => `${x.stroke}:${x.index}`)).size).toBe(8);
        for (const x of a) {
            const st = strokes[x.stroke]!;
            expect(['body', 'tail']).toContain(st.part);
            const p = st.points[x.index]!;
            expect(Math.hypot(p[0] - CAT_FACE.cx, p[1] - CAT_FACE.cy)).toBeGreaterThanOrEqual(CAT_FACE.r);
        }
        expect(outlineAnchors(strokes, 0)).toEqual([]);
    });

    it('说话时偶尔出现「喵~」,音量低或减少动态时不出现,同时不超过一个', () => {
        expect(bubbleOpacity(0, 1.6)).toBe(0);
        expect(bubbleOpacity(0.8, 1.6)).toBeGreaterThan(0.9);
        let quiet = createBubbles();
        for (let i = 0; i < 80; i++) quiet = stepBubbles(quiet, 50, true, 0.1, false);
        expect(quiet.bubbles).toHaveLength(0);
        let field = createBubbles();
        for (let i = 0; i < 50; i++) field = stepBubbles(field, 50, true, 0.9, false);
        expect(field.bubbles).toHaveLength(1);
        expect(field.bubbles[0]?.x).not.toBe(0);
        for (let i = 0; i < 200; i++) field = stepBubbles(field, 50, true, 0.9, false);
        expect(field.bubbles.length).toBeLessThanOrEqual(1);
        expect(stepBubbles(field, 16, true, 0.9, true).bubbles).toHaveLength(0);
    });
});

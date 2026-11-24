// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识模式(M12 knowledge-hero)的纯数据部分:主视觉画什么由各主题决定,这里只定义场景、分页上限、
// 命中路径和置顶排序,三个主题共用。

/** 一屏最多画的节点数;超出的部分由「加载更多」逐页加入。 */
export const MAX_VISIBLE_NODES = 300;

export interface KnowledgeNode {
    readonly id: string;
    readonly label: string;
    /** branch 可以继续展开(记忆类别、知识分类);leaf 是一条内容或记忆。 */
    readonly kind: 'branch' | 'leaf';
    /** 冲突中的记忆:画红圈。 */
    readonly conflict?: boolean;
    /** 本机置顶:排在同层最前。 */
    readonly pinned?: boolean;
}

export interface KnowledgeScene {
    /** 第一层:记忆三类 + 知识顶层分类。 */
    readonly roots: readonly KnowledgeNode[];
    /** 已展开的路径(从第一层到当前层);空数组表示停在第一层。左上胶囊的面包屑用它。 */
    readonly path: readonly { readonly id: string; readonly label: string }[];
    /** 当前展开节点的子项(最多 MAX_VISIBLE_NODES 个)。 */
    readonly children: readonly KnowledgeNode[];
    /** 选中的子项(显示气泡的那一个)。 */
    readonly selectedId: string | null;
    /** 键盘焦点所在的节点(高亮但不弹气泡)。 */
    readonly focusId: string | null;
    /** 搜索命中及其祖先:点亮整条路径。 */
    readonly hits: ReadonlySet<string>;
    /** 鼠标悬停的节点:放不下的标签悬停时才显示。 */
    readonly hoverId?: string | null;
    /** 气泡的实际尺寸(CSS 像素);没量到时按默认尺寸让位。 */
    readonly bubble?: { readonly w: number; readonly h: number } | null;
}

export const EMPTY_SCENE: KnowledgeScene = {
    roots: [],
    path: [],
    children: [],
    selectedId: null,
    focusId: null,
    hits: new Set(),
};

/** 当前展开的节点 id(path 的最后一个);在第一层时为 null。 */
export function expandedId(scene: Pick<KnowledgeScene, 'path'>): string | null {
    return scene.path[scene.path.length - 1]?.id ?? null;
}

/** 置顶的排在前面,其余保持原顺序;最多保留 limit 个。 */
export function orderNodes<T extends KnowledgeNode>(nodes: readonly T[], limit = MAX_VISIBLE_NODES): T[] {
    const pinned = nodes.filter((n) => n.pinned);
    const rest = nodes.filter((n) => !n.pinned);
    return [...pinned, ...rest].slice(0, limit);
}

/** 命中路径:每个命中的 id 和它的全部祖先都点亮。 */
export function hitPath(hits: readonly { id: string; ancestors: readonly string[] }[]): Set<string> {
    const out = new Set<string>();
    for (const h of hits) {
        out.add(h.id);
        for (const a of h.ancestors) out.add(a);
    }
    return out;
}

/** 气泡里的一句原文:取第一句(中英文句末标点),超长截断加省略号。 */
export function firstSentence(text: string, max = 80): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    // 中文句末标点后直接断句;英文的 . ! ? ; 后面要跟空白或结尾(避免把 3.5 这类数字断开)
    const m = /^(.+?(?:[。！？；]|[.!?;](?=\s|$)))/u.exec(clean);
    const sentence = m?.[1] ?? clean;
    return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export interface ScreenNode {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    /** 命中半径(CSS 像素)。 */
    readonly r: number;
}

/** 屏幕坐标拾取:取距离最近且在命中半径(含 slop)内的节点。 */
export function pickNode(nodes: readonly ScreenNode[], x: number, y: number, slop = 6): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d <= n.r + slop && d < bestD) {
            best = n.id;
            bestD = d;
        }
    }
    return best;
}

export interface Box {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 气泡在画布上占的区域:气泡底边中点在节点上方 14px(见 .kn-bubble 的 transform),连同节点本身。 */
export function bubbleBox(at: { x: number; y: number }, size?: { w: number; h: number } | null): Box {
    const w = size?.w ?? 240;
    const h = size?.h ?? 48;
    return { x: at.x - w / 2 - 4, y: at.y - 14 - h - 4, w: w + 8, h: h + 14 + 14 };
}

export interface LabelCandidate {
    readonly id: string;
    readonly text: string;
    /** 文字起点:align 为 left 时是左端,right 时是右端;y 是竖直中线。 */
    readonly x: number;
    readonly y: number;
    readonly align: 'left' | 'right';
    /** 换到节点另一侧时的文字起点(align 随之左右互换);不给就不换边。 */
    readonly flipX?: number;
    /** 越大越先放;悬停和键盘焦点的标签总是显示。 */
    readonly priority: number;
    readonly always?: boolean;
}

export interface PlacedLabel extends LabelCandidate {
    readonly shown: string;
}

const LABEL_H = 16;

function labelBox(c: LabelCandidate, width: number): Box {
    return { x: c.align === 'left' ? c.x : c.x - width, y: c.y - LABEL_H / 2, w: width, h: LABEL_H };
}

/** 同一个标签放到节点另一侧:起点换成 flipX,对齐左右互换。 */
function flipped(c: LabelCandidate): LabelCandidate | null {
    if (c.flipX === undefined) return null;
    return { ...c, x: c.flipX, flipX: c.x, align: c.align === 'left' ? 'right' : 'left' };
}

/**
 * 标签排布:按优先级依次放,和气泡、要避开的区域、已放下的标签都不重叠;放不下先截短,
 * 再换到节点另一侧(原文、截短各试一次),还放不下就不画(悬停或键盘聚焦时再显示)。
 * 悬停 / 焦点的标签总是画,但先试不压气泡和避让区的一侧。
 */
export function placeLabels(
    cands: readonly LabelCandidate[],
    measure: (text: string) => number,
    avoid: readonly Box[],
    short: (text: string, max: number) => string,
    minChars = 6,
): PlacedLabel[] {
    const order = cands
        .map((c, i) => ({ c, i }))
        .sort((a, b) => Number(!!b.c.always) - Number(!!a.c.always) || b.c.priority - a.c.priority || a.i - b.i);
    const taken: Box[] = [];
    const out: PlacedLabel[] = [];
    for (const { c } of order) {
        const other = flipped(c);
        if (c.always) {
            const width = measure(c.text);
            const covers = (side: LabelCandidate) => avoid.some((a) => boxesOverlap(a, labelBox(side, width)));
            const side = other && covers(c) && !covers(other) ? other : c;
            out.push({ ...side, shown: c.text });
            taken.push(labelBox(side, width));
            continue;
        }
        const texts = [c.text, short(c.text, minChars)].filter((t, k, list) => list.indexOf(t) === k);
        const tries = [c, ...(other ? [other] : [])].flatMap((side) => texts.map((text) => ({ side, text })));
        for (const { side, text } of tries) {
            const box = labelBox(side, measure(text));
            if (avoid.some((a) => boxesOverlap(a, box)) || taken.some((a) => boxesOverlap(a, box))) continue;
            out.push({ ...side, shown: text });
            taken.push(box);
            break;
        }
    }
    return out;
}

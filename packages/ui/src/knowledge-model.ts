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

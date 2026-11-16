// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 分类浏览器的纯逻辑(与视图无关,M10 的粒子球可以复用同一份树状态与选中状态,开发计划 4.1.1)。

export interface HasId {
    id: string;
}

/** 游标分页合并:同一个 id 只留一份(以新页为准,保持首次出现的位置),不丢项。 */
export function mergePage<T extends HasId>(existing: readonly T[], page: readonly T[]): T[] {
    const index = new Map<string, number>();
    const out = existing.slice();
    out.forEach((item, i) => index.set(item.id, i));
    for (const item of page) {
        const at = index.get(item.id);
        if (at === undefined) {
            index.set(item.id, out.length);
            out.push(item);
        } else {
            out[at] = item;
        }
    }
    return out;
}

export interface VirtualWindowInput {
    count: number;
    /** 固定行高(像素)。 */
    rowHeight: number;
    viewportHeight: number;
    scrollTop: number;
    /** 视口上下各多渲染的行数。 */
    overscan?: number;
}

export interface VirtualWindow {
    /** 渲染的第一行(含)。 */
    start: number;
    /** 渲染的最后一行(不含)。 */
    end: number;
    /** 第一行渲染行上方的占位高度。 */
    offsetTop: number;
    totalHeight: number;
}

/** 固定行高的虚拟窗口:只算范围,不碰 DOM。 */
export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
    const { count, rowHeight, viewportHeight } = input;
    const overscan = input.overscan ?? 4;
    const totalHeight = count * rowHeight;
    if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
    const top = Math.min(Math.max(0, input.scrollTop), Math.max(0, totalHeight - viewportHeight));
    const first = Math.floor(top / rowHeight);
    const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(count, last + overscan);
    return { start, end, offsetTop: start * rowHeight, totalHeight };
}

export interface Crumb {
    id: string;
    title: string;
}

/** 面包屑:祖先(自上而下)加当前条目;当前条目放最后。 */
export function breadcrumbOf(ancestors: readonly Crumb[], current: Crumb | null): Crumb[] {
    return current
        ? [...ancestors.map(({ id, title }) => ({ id, title })), { id: current.id, title: current.title }]
        : [];
}

/** 点击面包屑第 index 项后:回到那一层(返回新的面包屑与应选中的 id)。 */
export function crumbTo(trail: readonly Crumb[], index: number): { trail: Crumb[]; selectedId: string | null } {
    const next = trail.slice(0, Math.max(0, index + 1));
    return { trail: next, selectedId: next.at(-1)?.id ?? null };
}

/** 展开状态(不可变更新)。 */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
}

/** 选中某个条目时需要展开的祖先:保证树里能看到它。 */
export function expandAncestors(expanded: ReadonlySet<string>, ancestorIds: readonly string[]): Set<string> {
    const next = new Set(expanded);
    for (const id of ancestorIds) next.add(id);
    return next;
}

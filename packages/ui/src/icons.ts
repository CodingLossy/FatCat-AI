// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 单线图标库(M12,docs/design/ui-redesign.md 3.4):24px viewBox、无填充、圆头圆角、颜色 currentColor。
// 全部自绘,不引入图标库依赖。每个实现 PR 只加自己用到的图标;`paw-sm` 是 24px 以下使用的小尺寸版。
// 下面的 SHAPES 是固定的内置字符串(不含任何外部输入),可安全地作为 SVG 内部标记使用。

export const ICON_VIEWBOX = 24;
/** 描边宽度(与 tokens.css 的 --icon-stroke 一致);小尺寸版自带更粗的线条。 */
export const ICON_STROKE = 1.75;

const SHAPES = {
    paw: '<g transform="rotate(12 12 12)"><ellipse cx="5.6" cy="12" rx="1.7" ry="2.5" transform="rotate(-18 5.6 12)"/><ellipse cx="9.4" cy="6.9" rx="1.8" ry="2.7"/><ellipse cx="14.8" cy="6.5" rx="1.7" ry="2.5"/><ellipse cx="18.6" cy="11.6" rx="1.5" ry="2.1" transform="rotate(20 18.6 11.6)"/><path d="M12 12.6c-2.7 0-5 2.6-5 4.7 0 1.7 1.5 2.7 3.1 2.7 1 0 1.3-.5 1.9-.5s.9.5 1.9.5c1.6 0 3.1-1 3.1-2.7 0-2.1-2.3-4.7-5-4.7z"/></g>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    files: '<path d="M14 3H8a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h4M4 8v11a2 2 0 0 0 2 2h9"/>',
    gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
    diff: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10.5 6.7"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    brain: '<path d="M9.5 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 2.8 3 3 0 0 0 1.5 2.6 3 3 0 0 0 3.5 3.6 2.6 2.6 0 0 0 4.9 0 3 3 0 0 0 3.5-3.6 3 3 0 0 0 1.5-2.6 3 3 0 0 0-2-2.8 3 3 0 0 0-3-3 2.5 2.5 0 0 0-2.5-1.3 2.5 2.5 0 0 0-2.4 1.3z"/><path d="M12 5v14"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    fwd: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4.5h-4.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9.6 4.2 4.2 0 0 1 17.5 18z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chat: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11l-4 3.5V17H6a2 2 0 0 1-2-2z"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
    cat: '<path d="M5 9.5V4l4 2.8h6L19 4v5.5c1 1 1.5 2.4 1.5 3.8 0 3.6-3.7 6.2-8.5 6.2S3.5 16.9 3.5 13.3C3.5 11.9 4 10.5 5 9.5z"/><path d="M9 12.5v1M15 12.5v1M11 15.5h2"/>',
    'paw-sm':
        '<g transform="rotate(10 12 12)"><path d="M6 8.6v.01M12 5.6v.01M18 8.6v.01" stroke-width="3.4"/><path d="M12 12.6c-3.4 0-5.8 2.4-5.8 4.8 0 2 1.7 3.2 3.6 3.2 1.1 0 1.6-.6 2.2-.6s1.1.6 2.2.6c1.9 0 3.6-1.2 3.6-3.2 0-2.4-2.4-4.8-5.8-4.8z" stroke-width="2.2"/></g>',
} as const;

export type IconName = Exclude<keyof typeof SHAPES, 'paw-sm'>;

export const ICON_NAMES = Object.keys(SHAPES).filter((n) => n !== 'paw-sm') as IconName[];

/** 小于等于此尺寸(px)时,`paw` 换成加粗、去细节的小尺寸版(托盘与 16px 场景)。 */
export const SMALL_ICON_MAX_PX = 20;

/** 按显示尺寸选择实际使用的图形名:只有 `paw` 有小尺寸版。 */
export function resolveIconName(name: IconName, sizePx: number): IconName | 'paw-sm' {
    return name === 'paw' && sizePx <= SMALL_ICON_MAX_PX ? 'paw-sm' : name;
}

/** 某个图标的 SVG 内部标记(不含外层 <svg>)。 */
export function iconMarkup(name: IconName, sizePx = 24): string {
    return SHAPES[resolveIconName(name, sizePx)];
}

/** 完整的 <svg> 字符串,供不使用 React 的场景(构建脚本、画布)使用。 */
export function iconSvg(name: IconName, sizePx = 24): string {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}" ` +
        `width="${sizePx}" height="${sizePx}" fill="none" stroke="currentColor" stroke-width="${ICON_STROKE}" ` +
        `stroke-linecap="round" stroke-linejoin="round">${iconMarkup(name, sizePx)}</svg>`
    );
}

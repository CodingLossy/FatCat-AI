// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type IconName, ICON_STROKE, ICON_VIEWBOX, iconMarkup } from '@fatcat-ai/ui/icons';

/**
 * 单线图标(M12):颜色跟随 currentColor,只读内置的固定图形字符串。装饰用图标默认对读屏隐藏;
 * 需要朗读时传 `label`。尺寸 16 / 20 / 24,`paw` 在 20 以下自动换成加粗的小尺寸版。
 */
export function Icon({ name, size = 20, label }: { name: IconName; size?: 16 | 20 | 24; label?: string }) {
    return (
        <svg
            className="icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={ICON_STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            focusable="false"
            dangerouslySetInnerHTML={{ __html: iconMarkup(name, size) }}
        />
    );
}

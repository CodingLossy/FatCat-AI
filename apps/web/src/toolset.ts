// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { TaskPolicy } from '@fatcat-ai/shared';

/** 确认卡上的工具集输入(逗号、空格或换行分隔)→ 去重后的列表;空 = 不限制(返回 undefined)。 */
export function parseToolSet(text: string): string[] | undefined {
    const items = [...new Set(text.split(/[\s,，、]+/).filter((item) => item !== ''))];
    return items.length > 0 ? items : undefined;
}

/** 把工具集写进策略;不限制时去掉字段(PATCH 整体替换 policy),不留空数组。 */
export function withToolSet(policy: TaskPolicy, toolSet: string[] | undefined): TaskPolicy {
    const next = { ...policy };
    delete next.toolSet;
    return toolSet ? { ...next, toolSet } : next;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 别的页面建好的任务草稿(例如设置页从 Skill 模板建的)交给任务页显示确认卡;只在内存里,任务页挂载后清掉。
import type { TaskDraftResult } from '@fatcat-ai/shared';

let pending: TaskDraftResult | null = null;

export function handOffDraft(draft: TaskDraftResult): void {
    pending = draft;
}

/** 读出交来的草稿(可以读多次:StrictMode 下初始化函数会跑两次);任务页挂载后用 clearDraft 清掉。 */
export function peekDraft(): TaskDraftResult | null {
    return pending;
}

export function clearDraft(): void {
    pending = null;
}

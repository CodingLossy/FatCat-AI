// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面深链接 fatcat-ai://ask?text=... 会把文本放进 /?ask=...,只预填输入框,永不自动发送(ADR 0044)。
const MAX_ASK_CHARS = 2000;

/** 取出 `ask` 参数;`rest` 是去掉它之后应保留的查询串(含 `?`,没有则为空串)。 */
export function takeAskParam(search: string): { text: string; rest: string } {
    const params = new URLSearchParams(search);
    const raw = params.get('ask');
    if (raw === null) return { text: '', rest: search };
    params.delete('ask');
    const rest = params.toString();
    return {
        text: raw.slice(0, MAX_ASK_CHARS).trim() ? raw.slice(0, MAX_ASK_CHARS) : '',
        rest: rest ? `?${rest}` : '',
    };
}

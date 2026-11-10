// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 按字符的保守 token 估算(M2 方案第 4 节第 9 条):中日韩文字约 1 字 = 1 token,其余约 4 个字符 = 1 token。
// 与 packages/agent 的估算规则相同;这里单独实现,memory 不依赖 agent。

const isCjk = (code: number) =>
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f);

export function estimateTokens(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        if (isCjk(ch.codePointAt(0) ?? 0)) cjk++;
        else other++;
    }
    return cjk + Math.ceil(other / 4);
}

/** 截断到不超过 max 个 token(估算),截断时以「…」结尾。 */
export function truncateToTokens(text: string, max: number): string {
    if (estimateTokens(text) <= max) return text;
    let out = '';
    for (const ch of text) {
        if (estimateTokens(`${out}${ch}…`) > max) break;
        out += ch;
    }
    return `${out}…`;
}

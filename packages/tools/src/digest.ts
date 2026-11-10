// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/** 审计中入参摘要的长度上限(与 shared 的 AuditEntry.inputDigest 一致)。 */
export const DIGEST_LIMIT = 500;

/** 入参的脱敏摘要:序列化 → 脱敏 → 截断到 500 字符(ADR 0010 第 6 节)。 */
export function inputDigest(input: unknown, redact: (text: string) => string): string {
    let text: string;
    try {
        text = JSON.stringify(input) ?? 'null';
    } catch {
        text = '[unserializable input]';
    }
    text = redact(text);
    return text.length > DIGEST_LIMIT ? `${text.slice(0, DIGEST_LIMIT - 1)}…` : text;
}

/** 存进审批请求的入参:脱敏后仍是结构化数据;脱敏破坏了 JSON 时退回为字符串。 */
export function redactedInput(input: unknown, redact: (text: string) => string): unknown {
    let text: string;
    try {
        text = JSON.stringify(input) ?? 'null';
    } catch {
        return '[unserializable input]';
    }
    const redacted = redact(text);
    if (redacted === text) return input ?? null;
    try {
        return JSON.parse(redacted) as unknown;
    } catch {
        return redacted;
    }
}

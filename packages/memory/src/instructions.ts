// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 指令性语句检测(《记忆模块补充设计》第 3 节第 3 条):来自非用户的「以后都把…发给…」之类内容
// 不能成为记忆,一律进隔离区。纯函数;规则由本项目自行编写,宁可多拦(进隔离区还可以人工提升)。

const PATTERNS: readonly RegExp[] = [
    // 「以后 / 每次 / 自动 … 转发 / 发给 / 转账 …」
    /(?:以后|今后|往后|从现在起|从现在开始|从今天起|每次|每当|总是|一律|始终|自动)[^。\n]{0,40}?(?:转发|发送|发给|发到|抄送|转给|转账|打款|汇款|付款|上传|删除|分享给|告诉)/,
    // 「记住:以后…」「请记住,从现在开始…」
    /记住\s*[:：,，]?\s*(?:以后|今后|从现在|每次|永远|一定要)/,
    // 忽略之前的指令 / 系统提示
    /忽略(?:之前|以上|前面|先前|上面)的?(?:所有)?(?:指令|指示|提示|要求|规则)/,
    /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)\b/i,
    // from now on / always / whenever … forward / send / email …
    /\b(?:from now on|always|whenever|every time|in the future|going forward)\b[^.\n]{0,60}?\b(?:forward|send|e-?mail|transfer|wire|pay|upload|delete|share|cc|bcc)\b/i,
    // forward … to someone@example.com
    /\b(?:forward|send|cc|bcc)\b[^.\n]{0,60}?\bto\s+\S+@\S+/i,
    /(?:转发|发送|发给|抄送|转给)[^。\n]{0,30}?[\w.+-]+@[\w-]+\.[\w.-]+/,
];

/** 文本是否像一条要执行的指令(而不是关于用户的事实)。 */
export function looksLikeInstruction(text: string): boolean {
    return PATTERNS.some((re) => re.test(text));
}

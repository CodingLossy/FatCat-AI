// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 内置工具执行时的状态文字(ADR 0021 第 7 节)。按工具名前缀取默认值;工具自己声明的 activityLabel 优先。
import type { ActivityLabel } from '@fatcat-ai/shared';

const EXACT: Record<string, ActivityLabel> = {
    'mail.send': { 'zh-CN': '正在发送邮件…', en: 'Sending email…' },
    'mail.draft': { 'zh-CN': '正在写邮件草稿…', en: 'Drafting an email…' },
    'mail.summarize': { 'zh-CN': '正在总结邮件…', en: 'Summarizing email…' },
    'web.fetch': { 'zh-CN': '正在读取网页…', en: 'Reading a web page…' },
    'fs.write': { 'zh-CN': '正在写入文件…', en: 'Writing a file…' },
    'fs.move': { 'zh-CN': '正在移动文件…', en: 'Moving a file…' },
    'memory.save': { 'zh-CN': '正在记住…', en: 'Remembering…' },
    'memory.forget': { 'zh-CN': '正在删除记忆…', en: 'Forgetting…' },
};

const PREFIX: Record<string, ActivityLabel> = {
    'fs.': { 'zh-CN': '正在查看文件…', en: 'Looking at files…' },
    'mail.': { 'zh-CN': '正在查看邮件…', en: 'Checking email…' },
    'memory.': { 'zh-CN': '正在查看记忆…', en: 'Checking memories…' },
    'kb.': { 'zh-CN': '正在查找资料…', en: 'Searching the knowledge base…' },
    'items.': { 'zh-CN': '正在查找资料…', en: 'Looking things up…' },
};

/** 内置工具的默认状态文字;没有对应项(包括 MCP 工具)时返回 undefined。 */
export function defaultActivityLabel(name: string): ActivityLabel | undefined {
    if (name.startsWith('mcp.')) return undefined;
    return EXACT[name] ?? Object.entries(PREFIX).find(([prefix]) => name.startsWith(prefix))?.[1];
}

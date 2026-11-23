// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Locale } from './locale.js';

// 注入给模型 / 展示给用户的服务器端短文案,按语言提供模板;缺少某语言时回落 en。
type Template = (args: Record<string, string>) => string;
const templates: Record<string, Partial<Record<Locale, Template>> & { en: Template }> = {
    currentTime: {
        'zh-CN': ({ time }) => `当前时间:${time}。`,
        en: ({ time }) => `Current time: ${time}.`,
    },
    usingTool: {
        'zh-CN': ({ name }) => `正在使用 ${name}…`,
        en: ({ name }) => `Using ${name}…`,
    },
    // 系统提示末尾的按需组目录(ADR 0047 第 1.4 节);groups 由 toolGroupLabel 拼成
    toolGroupCatalog: {
        en: ({ groups }) => `Optional tool groups (turn one on with tools.enable): ${groups}.`,
    },
    // 普通对话与定时任务用完本次运行的 token 预算时,附在回答末尾(ADR 0047 第 2 节)
    runBudget: {
        'zh-CN': () => '(本次回答已用完 token 预算,先停在这里。需要的话请让我继续。)',
        en: () => '(This answer used up its token budget, so I stopped here. Ask me to continue if you need more.)',
    },
};

/** 按需组的一句话说明(每组不超过 8 个词,给模型看,只有英文)。 */
const TOOL_GROUP_DESCRIPTIONS: Record<string, string> = {
    fs: 'local files in folders the user allowed',
    mail: 'e-mail',
    web: 'fetch a web page',
    browser: 'open and read web pages in a browser',
    channel: 'send a message to a chat channel',
    system: 'open files and links on the desktop',
};

/** 目录里的一项:`fs (local files …)`;MCP 与插件组按服务器名 / 插件 id 说明,未知的组只有名字。 */
export function toolGroupLabel(group: string): string {
    const known = TOOL_GROUP_DESCRIPTIONS[group];
    if (known) return `${group} (${known})`;
    if (group.startsWith('mcp.')) return `${group} (tools from MCP server ${group.slice(4)})`;
    if (group.startsWith('plugin.')) return `${group} (tools from plugin ${group.slice(7)})`;
    return group;
}

export type PromptName = keyof typeof templates;

export function promptText(name: PromptName, locale: Locale, args: Record<string, string> = {}): string {
    const t = templates[name]!;
    return (t[locale] ?? t.en)(args);
}

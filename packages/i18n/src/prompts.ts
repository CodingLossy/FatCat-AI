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
};

export type PromptName = keyof typeof templates;

export function promptText(name: PromptName, locale: Locale, args: Record<string, string> = {}): string {
    const t = templates[name]!;
    return (t[locale] ?? t.en)(args);
}

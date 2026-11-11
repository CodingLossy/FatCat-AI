// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// assistant-state 的状态文字(ADR 0021 第 7 节):按设置里的界面语言在服务器端生成,客户端直接显示。
import type { ActivityLabel, AssistantState, Locale } from '@fatcat-ai/shared';

const LABELS: Record<Exclude<AssistantState, 'executing'>, ActivityLabel> = {
    idle: { 'zh-CN': '空闲', en: 'Idle' },
    listening: { 'zh-CN': '正在听…', en: 'Listening…' },
    thinking: { 'zh-CN': '正在思考…', en: 'Thinking…' },
    speaking: { 'zh-CN': '正在朗读…', en: 'Speaking…' },
};

/** executing 时优先用工具的 activityLabel,否则「正在使用 <工具名>…」。 */
export function assistantLabel(
    state: AssistantState,
    locale: Locale,
    tool?: { name: string; activityLabel?: ActivityLabel | undefined },
): string {
    if (state !== 'executing') return LABELS[state][locale];
    if (tool?.activityLabel) return tool.activityLabel[locale];
    const name = tool?.name ?? '';
    return locale === 'en' ? `Using ${name}…` : `正在使用 ${name}…`;
}

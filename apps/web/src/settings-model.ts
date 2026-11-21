// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页(M12 PR 5,docs/design/ui-redesign.md 第 9 节)的纯逻辑:分区与子菜单、用量汇总、折线点。

import type { IconName } from '@fatcat-ai/ui/icons';
import { navigate } from './router.js';

export type SettingsSectionId = 'workbench' | 'models' | 'tools' | 'system';

export interface SettingsItem {
    id: string;
    icon: IconName;
    /** i18n 键(settings.item.*)。 */
    label: string;
}

export interface SettingsSection {
    id: SettingsSectionId;
    icon: IconName;
    items: SettingsItem[];
}

/** 现有设置内容按功能归入四个分区;行为不变,只调整布局。 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
    {
        id: 'workbench',
        icon: 'gear',
        items: [
            { id: 'general', icon: 'gear', label: 'settings.item.general' },
            { id: 'files', icon: 'folder', label: 'settings.item.files' },
            { id: 'mail', icon: 'mail', label: 'settings.item.mail' },
            { id: 'channels', icon: 'chat', label: 'settings.item.channels' },
        ],
    },
    {
        id: 'models',
        icon: 'pulse',
        items: [
            { id: 'overview', icon: 'pulse', label: 'settings.item.overview' },
            { id: 'voice', icon: 'mic', label: 'settings.item.voice' },
            { id: 'embedding', icon: 'brain', label: 'settings.item.embedding' },
        ],
    },
    {
        id: 'tools',
        icon: 'plug',
        items: [
            { id: 'mcp', icon: 'plug', label: 'settings.item.mcp' },
            { id: 'preauth', icon: 'check', label: 'settings.item.preauth' },
            { id: 'browser', icon: 'globe', label: 'settings.item.browser' },
            { id: 'market', icon: 'cloud', label: 'settings.item.market' },
        ],
    },
    {
        id: 'system',
        icon: 'lock',
        items: [
            { id: 'account', icon: 'user', label: 'settings.item.account' },
            { id: 'secrets', icon: 'lock', label: 'settings.item.secrets' },
            { id: 'network', icon: 'globe', label: 'settings.item.network' },
        ],
    },
];

/** 首次进入设置时落在「模型与语音 / 概览」:首次启动要先配置模型。 */
export const DEFAULT_SETTINGS_VIEW = { section: 'models' as SettingsSectionId, item: 'overview' };

export interface SettingsView {
    section: SettingsSectionId;
    item: string;
}

/** 把任意输入(例如 sessionStorage 里读出的字符串)规整成合法的 (分区, 子项);不合法就回默认。 */
export function resolveView(section: unknown, item: unknown): SettingsView {
    const s = SETTINGS_SECTIONS.find((x) => x.id === section);
    if (!s) return { ...DEFAULT_SETTINGS_VIEW };
    const it = s.items.find((x) => x.id === item) ?? s.items[0]!;
    return { section: s.id, item: it.id };
}

/** 设置页记住上次所在分区用的 sessionStorage 键。 */
export const SETTINGS_VIEW_KEY = 'fatcat.settings.view';

/** 先记下要去的分区和子项,再切到设置页;设置页挂载时读取。sessionStorage 不可用时落到默认分区。 */
export function openSettingsAt(section: SettingsSectionId, item: string): void {
    try {
        window.sessionStorage.setItem(SETTINGS_VIEW_KEY, JSON.stringify(resolveView(section, item)));
    } catch {
        // 没有 sessionStorage:打开默认分区
    }
    navigate({ name: 'settings' });
}

export interface UsageLike {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
}

export interface UsageTotals {
    input: number;
    output: number;
}

/** 累加消息里的 usage;没有 usage 的消息(用户消息、旧数据)跳过,不编造数字。 */
export function sumUsage(items: ReadonlyArray<{ usage?: UsageLike | null }>): UsageTotals {
    let input = 0;
    let output = 0;
    for (const m of items) {
        input += m.usage?.inputTokens ?? 0;
        output += m.usage?.outputTokens ?? 0;
    }
    return { input, output };
}

/** 输入占比(0..1);两者都是 0 时返回 null,界面显示空状态而不是环形图。 */
export function inputShare(totals: UsageTotals): number | null {
    const sum = totals.input + totals.output;
    return sum === 0 ? null : totals.input / sum;
}

/** 把 /healthz 探测耗时画成折线的点;样本少于 2 个返回 null。 */
export function sparkPoints(samples: readonly number[], width: number, height: number): string | null {
    if (samples.length < 2) return null;
    const max = Math.max(...samples, 1);
    const step = width / (samples.length - 1);
    return samples
        .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`)
        .join(' ');
}

/** 给探测历史追加一个样本,只保留最近 `limit` 个。 */
export function pushSample(samples: readonly number[], value: number, limit = 20): number[] {
    return [...samples, value].slice(-limit);
}

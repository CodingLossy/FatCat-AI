// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件页的纯函数:插件文案按界面语言取值、设置表单的初值与取值、内存读数格式化。
import type { PluginSettings } from '@fatcat-ai/shared';

/** 插件的 i18n 文案(至少有一种语言):优先当前界面语言,否则取另一种。只当纯文本显示。 */
export function pickText(text: { 'zh-CN'?: string | undefined; en?: string | undefined }, locale: string): string {
    const preferred = locale === 'en' ? text.en : text['zh-CN'];
    return preferred ?? text.en ?? text['zh-CN'] ?? '';
}

export type SettingsDraft = Record<string, string | boolean>;

/** 表单草稿:已保存的值优先,其次是声明的默认值;boolean 没有值时为 false,其余为空串。 */
export function settingsDraft(schema: PluginSettings, saved: Record<string, unknown>): SettingsDraft {
    const draft: SettingsDraft = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
        const value = saved[key] ?? prop.default;
        if (prop.type === 'boolean') draft[key] = value === true;
        else draft[key] = value === undefined ? '' : String(value);
    }
    return draft;
}

/** 把表单草稿转成 PATCH 的 settings:空的可选项省略;number 项不是数字时返回错误键,交给界面提示。 */
export function settingsValues(
    schema: PluginSettings,
    draft: SettingsDraft,
): { values: Record<string, unknown>; invalid: string[] } {
    const values: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const [key, prop] of Object.entries(schema.properties)) {
        const raw = draft[key];
        if (prop.type === 'boolean') {
            values[key] = raw === true;
        } else if (raw === undefined || raw === '') {
            continue;
        } else if (prop.type === 'number') {
            const n = Number(raw);
            if (Number.isFinite(n)) values[key] = n;
            else invalid.push(key);
        } else {
            values[key] = String(raw);
        }
    }
    return { values, invalid };
}

/** 内存读数:字节 → MiB 一位小数;没有读数时 null。 */
export function formatRss(bytes: number | null): string | null {
    return bytes === null ? null : `${(bytes / 1048576).toFixed(1)} MiB`;
}

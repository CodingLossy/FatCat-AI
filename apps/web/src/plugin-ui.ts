// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件页的纯函数:插件文案按界面语言取值、设置表单的初值与取值、内存读数格式化。
import type { PluginPermissions, PluginSettings } from '@fatcat-ai/shared';

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

/** 市场条目里某个版本的权限摘要(列表里一行);没有任何权限时返回空数组。 */
export function permissionSummary(
    permissions: PluginPermissions,
): { key: 'tools' | 'net' | 'secrets' | 'items'; count: number }[] {
    const rows: { key: 'tools' | 'net' | 'secrets' | 'items'; count: number }[] = [
        { key: 'tools', count: permissions.tools.length },
        { key: 'net', count: permissions.net.length },
        { key: 'secrets', count: permissions.secrets.length },
        { key: 'items', count: permissions.items?.categories.length ?? 0 },
    ];
    return rows.filter((row) => row.count > 0);
}

/** 市场里默认选哪个版本:最新的、与当前核心兼容的;都不兼容时选最新的(界面会提示不兼容)。 */
export function defaultMarketVersion(versions: readonly { version: string; compatible: boolean }[]): string | null {
    return (versions.find((v) => v.compatible) ?? versions[0])?.version ?? null;
}

/** 密钥绑定表单提交的内容:改了的写新值,清空了已绑定的写 null(解除绑定),没动的不提交。 */
export function secretRefChanges(
    draft: Record<string, string>,
    saved: Record<string, string>,
): Record<string, string | null> {
    const changed: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(draft)) {
        const ref = value.trim();
        if (ref === '' && saved[name] !== undefined) changed[name] = null;
        else if (ref !== '' && ref !== saved[name]) changed[name] = ref;
    }
    return changed;
}

const MARKET_ERROR_CODES = [
    'index_download_failed',
    'index_signature_invalid',
    'index_unknown_key',
    'index_invalid',
    'index_wrong_market',
    'index_rollback',
    'index_expired',
] as const;

/** 市场状态里的原因码 → 界面文案的键;不认识的码返回 null(界面直接显示服务器给的说明)。 */
export function marketErrorKey(code: string): `plugins.market.err.${(typeof MARKET_ERROR_CODES)[number]}` | null {
    return (MARKET_ERROR_CODES as readonly string[]).includes(code)
        ? (`plugins.market.err.${code}` as `plugins.market.err.${(typeof MARKET_ERROR_CODES)[number]}`)
        : null;
}

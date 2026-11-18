// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件管理的 REST 契约(ADR 0040 第 9 节,/api/v1 的增量)。PR 2b 提供本地目录来源;市场与升级见后续 PR。
import { z } from 'zod';
import { PluginManifest, PluginPermissions, PluginSettings, PluginTaskTemplate } from './plugin.js';

export const PluginState = z.enum([
    'enabled',
    'disabled',
    'error',
    'incompatible',
    'upgrade-pending',
    'uninstalling',
    'uninstalled',
]);
export type PluginState = z.infer<typeof PluginState>;

export const PluginRunInfo = z.object({
    state: z.enum(['running', 'idle', 'starting', 'error', 'disabled']),
    /** 已注册进工具表的工具名(plugin.<id>.<tool>)。 */
    tools: z.array(z.string()),
    /** 最近一次 RSS 读数(字节);没有读数时 null。 */
    rssBytes: z.number().int().min(0).nullable(),
    /** measured:主程序测量(Linux / macOS);self-reported:插件心跳自报(Windows)。 */
    rssSource: z.enum(['measured', 'self-reported']).nullable(),
});
export type PluginRunInfo = z.infer<typeof PluginRunInfo>;

/** 单插件的运行设置(第 8 节);默认都不设。 */
export const PluginRuntimeSettingsInput = z.strictObject({
    maxOldSpaceMiB: z.number().int().min(16).max(65536).nullable().optional(),
    maxSemiSpaceMiB: z.number().int().min(1).max(1024).nullable().optional(),
    memoryThresholdMiB: z.number().int().min(16).max(1_048_576).nullable().optional(),
});
export type PluginRuntimeSettingsInput = z.infer<typeof PluginRuntimeSettingsInput>;

/** 第 3.5 节的保护程度表的一行;`detail` 由主程序按当前平台填写。 */
export const PluginProtection = z.object({
    key: z.enum([
        'approval',
        'untrusted-output',
        'host-files',
        'environment',
        'brokered-network',
        'direct-network',
        'items-quota',
        'memory-threshold',
        'review',
    ]),
    level: z.enum(['enforced', 'layered', 'self-reported', 'unverified', 'none']),
    detail: z.string(),
});
export type PluginProtection = z.infer<typeof PluginProtection>;

export const PluginView = z.object({
    id: z.string(),
    version: z.string(),
    previousVersion: z.string().nullable(),
    name: PluginManifest.shape.name,
    description: PluginManifest.shape.description,
    author: z.string(),
    license: z.string(),
    homepage: z.string().nullable(),
    state: PluginState,
    error: z.string().nullable(),
    sourceKind: z.enum(['local', 'market']),
    sourceRef: z.string(),
    /** 本地目录安装:未经市场审核、未签名。 */
    unreviewed: z.boolean(),
    permissions: PluginPermissions,
    /** 名字 -> `env:变量名`。 */
    secretRefs: z.record(z.string(), z.string()),
    /** 缺少的必需密钥绑定(为空才能启用)。 */
    missingSecrets: z.array(z.string()),
    settings: z.record(z.string(), z.unknown()),
    /** 清单里的 `settings` 声明(JSON Schema 子集),界面按它渲染表单;没有声明时 null。 */
    settingsSchema: PluginSettings.nullable(),
    /** 清单里的任务模板;只能从模板建任务草稿,不能直接建任务。 */
    taskTemplates: z.array(PluginTaskTemplate),
    runtime: PluginRuntimeSettingsInput,
    run: PluginRunInfo,
    installedAt: z.string(),
    updatedAt: z.string(),
});
export type PluginView = z.infer<typeof PluginView>;

export const PluginDetail = PluginView.extend({
    /** 卸载会停用的任务(工具集或预授权白名单引用了该插件的工具)。 */
    affectedTasks: z.array(z.object({ id: z.string(), name: z.string() })),
    /** 第 3.5 节的保护程度表(当前平台的真实程度),安装后在详情页继续显示。 */
    protections: z.array(PluginProtection),
});
export type PluginDetail = z.infer<typeof PluginDetail>;

export const PluginPrepareInput = z.strictObject({
    source: z.strictObject({ kind: z.literal('local'), path: z.string().min(1).max(1024) }),
});
export type PluginPrepareInput = z.infer<typeof PluginPrepareInput>;

export const PluginPrepared = z.object({
    stagingId: z.string(),
    manifest: PluginManifest,
    protections: z.array(PluginProtection),
    unreviewed: z.boolean(),
    /** 已安装的同名插件(PR 2b 不支持升级,安装会被拒绝)。 */
    installed: z.object({ version: z.string(), state: PluginState }).nullable(),
});
export type PluginPrepared = z.infer<typeof PluginPrepared>;

export const PluginInstallInput = z.strictObject({
    stagingId: z.string().regex(/^[a-f0-9]{16}$/),
    /** 必须为 true:全部同意才能安装,不能只勾一部分。 */
    accept: z.literal(true),
});
export type PluginInstallInput = z.infer<typeof PluginInstallInput>;

export const PluginPatch = z.strictObject({
    enabled: z.boolean().optional(),
    secretRefs: z
        .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]{0,63}$/))
        .optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    runtime: PluginRuntimeSettingsInput.optional(),
});
export type PluginPatch = z.infer<typeof PluginPatch>;

export const PluginEventView = z.object({
    id: z.string(),
    at: z.string(),
    pluginId: z.string(),
    version: z.string().nullable(),
    kind: z.string(),
    detail: z.string().nullable(),
});
export type PluginEventView = z.infer<typeof PluginEventView>;

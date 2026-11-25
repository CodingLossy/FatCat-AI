// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件市场的契约(ADR 0040 第 5.2、5.3、9 节,/api/v1 的增量,自 M7 PR 4 起提供)。
import { z } from 'zod';
import { PluginPermissions, PluginId } from './plugin.js';
import { PluginState } from './plugin-api.js';

/**
 * `index.json.sig` 的内容:对 `index.json` 原始字节的 Ed25519 签名。
 * `keyId` 指向客户端内置(或 config.yaml 里配置)的公钥;未知的 keyId 一律拒绝。
 */
export const PluginIndexSignature = z.strictObject({
    keyId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    alg: z.literal('ed25519'),
    /** 64 字节签名的 base64。 */
    sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'must be the base64 of a 64-byte signature'),
});
export type PluginIndexSignature = z.infer<typeof PluginIndexSignature>;

/** 一个市场在这台机器上的当前状态。 */
export const PluginMarketStatus = z.object({
    id: z.string(),
    /** 内置的官方市场。 */
    official: z.boolean(),
    /**
     * ok:缓存的索引有效;stale:最近一次更新失败或被拒绝,显示的是缓存里的旧索引;
     * unavailable:没有可用的索引(从未下载成功,或缓存已过期),不能安装。
     */
    state: z.enum(['ok', 'stale', 'unavailable']),
    /** 验证当前索引用的公钥 id。 */
    keyId: z.string().nullable(),
    serial: z.number().int().nullable(),
    /** 当前索引是什么时候下载并验证通过的。 */
    fetchedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    /** 最近一次更新失败的原因;`code` 稳定(index_download_failed、index_signature_invalid、index_rollback、index_expired 等)。 */
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PluginMarketStatus = z.infer<typeof PluginMarketStatus>;

export const PluginMarketVersionView = z.object({
    version: z.string(),
    engines: z.string(),
    size: z.number().int(),
    publishedAt: z.string(),
    permissions: PluginPermissions,
    /** 当前核心版本是否满足 engines。 */
    compatible: z.boolean(),
    /** 纯指令插件的版本(不起进程);旧服务器不返回,按 false 处理。 */
    instructionOnly: z.boolean().optional(),
});
export type PluginMarketVersionView = z.infer<typeof PluginMarketVersionView>;

export const PluginMarketPluginView = z.object({
    market: z.string(),
    id: PluginId,
    name: z.record(z.string(), z.string()),
    description: z.record(z.string(), z.string()),
    author: z.string(),
    license: z.string(),
    homepage: z.string().nullable(),
    /** 没有被下架的版本,新的在前;全部被下架的插件不出现。 */
    versions: z.array(PluginMarketVersionView),
    installed: z.object({ version: z.string(), state: PluginState }).nullable(),
    /** 最新版本带的 Skill(id 与给模型看的一句话);旧服务器不返回。 */
    skills: z.array(z.object({ id: z.string(), description: z.string() })).optional(),
});
export type PluginMarketPluginView = z.infer<typeof PluginMarketPluginView>;

/** GET /plugins/market 与 POST /plugins/market/refresh;设置里关闭「插件市场」时两者都回 409 `market_disabled`。 */
export const PluginMarketListing = z.object({
    markets: z.array(PluginMarketStatus),
    plugins: z.array(PluginMarketPluginView),
});
export type PluginMarketListing = z.infer<typeof PluginMarketListing>;

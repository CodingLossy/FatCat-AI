// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 外连目标清单(ADR 0028,自 M5b 起提供)。零遥测的承诺落到一份可核对的清单上。
import { z } from 'zod';

export const EgressCategory = z.enum([
    'model',
    'embedding',
    'voice',
    'mail',
    'channel',
    'mcp',
    'plugin',
    'update-check',
]);
export type EgressCategory = z.infer<typeof EgressCategory>;

/** 只到协议 + 主机 + 端口:不含路径、查询、片段与凭据。 */
export const EgressOrigin = z
    .string()
    .max(300)
    .regex(/^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]+$/, 'scheme://host[:port] only');

export const EgressTarget = z.object({
    /** 稳定 id,形如 `model:<profileId>`、`mail:<accountId>:imap`。 */
    id: z.string().min(1).max(200),
    category: EgressCategory,
    /** 显示名,来自用户的配置,按不可信文本显示。 */
    label: z.string().max(200),
    /** stdio 类 MCP 服务器是本地进程,没有 origin,其自身的外连不在清单内。 */
    origin: EgressOrigin.nullable(),
    /** origin 为 null 时为 true:本地进程。 */
    local: z.boolean(),
    /** 来自哪个配置对象。 */
    source: z.object({ kind: z.string().min(1).max(60), id: z.string().min(1).max(200) }),
    /** 当前是否会被使用(例如被停用的渠道为 false)。 */
    enabled: z.boolean(),
});
export type EgressTarget = z.infer<typeof EgressTarget>;

/** GET /api/v1/settings/egress-targets。 */
export const EgressTargetList = z.object({ targets: z.array(EgressTarget) });
export type EgressTargetList = z.infer<typeof EgressTargetList>;

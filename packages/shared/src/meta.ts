// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';

/** WebSocket / API 协议主版本号,对应 `/api/v1`。 */
export const PROTOCOL_VERSION = 1;

/** 社区版许可证(SPDX 标识)。 */
export const SERVER_LICENSE = 'AGPL-3.0-only';

/** 官方源码仓库地址;修改版部署者应通过 FATCAT_AI_SOURCE_URL 改为自己的源码地址(AGPL §13)。 */
export const OFFICIAL_SOURCE_URL = 'https://github.com/CodingLossy/FatCat-AI';

/** `GET /healthz` 响应。 */
export const HealthResponseSchema = z.object({
    status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `GET /api/v1/meta` 响应,客户端据此做能力协商与 AGPL §13 源码链接展示。 */
export const MetaResponseSchema = z.object({
    name: z.literal('FatCat-AI'),
    serverVersion: z.string(),
    protocolVersion: z.number().int().positive(),
    license: z.string(),
    /** 当前部署所运行版本的完整源码地址;未配置时为 null。 */
    sourceUrl: z.url().nullable(),
    capabilities: z.array(z.string()),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

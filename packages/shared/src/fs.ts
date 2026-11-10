// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地文件工具的授权目录(ADR 0011):只能由用户经 API / UI 增删,模型不能修改。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

export const FsRoot = z.object({
    id: Id,
    /** 服务器规范化后的真实路径(realpath;Windows 上为长文件名与真实大小写)。 */
    path: z.string(),
    label: z.string(),
    /** 这个目录里的文件是否进入本地知识库;默认不进入(ADR 0015 第 6 节)。自 M2 PR 15 起提供。 */
    knowledgeBase: z.boolean(),
    createdAt: IsoDateTime,
});
export type FsRoot = z.infer<typeof FsRoot>;

export const FsRootInput = z.strictObject({
    path: z.string().min(1).max(4096),
    label: z.string().max(60).optional(),
    /** 授权的同时加入知识库;默认 false。 */
    knowledgeBase: z.boolean().optional(),
});
export type FsRootInput = z.infer<typeof FsRootInput>;

/** PATCH /api/v1/fs/roots/{id}:目前只能切换是否进入知识库。 */
export const FsRootPatch = z.strictObject({ knowledgeBase: z.boolean() });
export type FsRootPatch = z.infer<typeof FsRootPatch>;

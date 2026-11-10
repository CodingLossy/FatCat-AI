// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { Id } from './common.js';

export const Locale = z.enum(['zh-CN', 'en']);
export const Theme = z.enum(['system', 'light', 'dark']);

/** GET / PUT /api/v1/settings。PUT 接受部分字段并与现有设置合并。 */
export const Settings = z.object({
    defaultChatProfileId: Id.nullable(),
    /** 上下文压缩等廉价任务用的配置档;为 null 时回退到 chat 配置档(ADR 0006)。 */
    defaultCheapProfileId: Id.nullable(),
    locale: Locale,
    theme: Theme,
    memory: z.object({
        /** 每轮结束后用 cheap 模型从用户消息与最终回答中抽取记忆;默认关闭(ADR 0007 第 5.1 节)。 */
        autoExtract: z.boolean(),
        /** 自动抽取每天最多调用 cheap 模型的次数。自 M2 PR 11 起提供。 */
        extractDailyLimit: z.number().int().min(0).max(1000),
        /** memory.write 每次都要审批:关闭条件预授权(ADR 0010 第 4 节)。自 M2 PR 11 起提供。 */
        alwaysApprove: z.boolean(),
        /** 会话开头 digest 的 token 上限(ADR 0007 第 5.1 节)。自 M2 PR 12 起提供。 */
        digestTokens: z.number().int().min(100).max(1000),
        /** 每轮记忆块的 token 上限,另外不超过模型上下文的 10%。自 M2 PR 12 起提供。 */
        blockTokens: z.number().int().min(200).max(4000),
    }),
    /** 本地知识库(ADR 0015)。自 M2 PR 9 起提供。 */
    knowledgeBase: z.object({
        /** 每块的目标字符数;修改后文件在下一次索引时重新分块。 */
        chunkChars: z.number().int().min(200).max(4000),
    }),
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = Settings.partial().extend({
    memory: Settings.shape.memory.partial().optional(),
    knowledgeBase: Settings.shape.knowledgeBase.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const DEFAULT_SETTINGS: Settings = {
    defaultChatProfileId: null,
    defaultCheapProfileId: null,
    locale: 'zh-CN',
    theme: 'system',
    memory: { autoExtract: false, extractDailyLimit: 200, alwaysApprove: false, digestTokens: 400, blockTokens: 1200 },
    knowledgeBase: { chunkChars: 1000 },
};

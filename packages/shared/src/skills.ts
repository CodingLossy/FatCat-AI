// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Skills 的公开契约(ADR 0048 第 3、10 节):GET /api/v1/skills 的条目与 skill.use 的结果。
import { z } from 'zod';
import { PluginSkillTaskTemplate, pluginText } from './plugin.js';

/** 全局 Skill id:内置的是 `<id>`,插件的是 `plugin.<pluginId>.<id>`。 */
export const SkillGlobalId = z
    .string()
    .regex(/^(?:plugin\.[a-z][a-z0-9-]{1,31}\.)?[a-z][a-z0-9-]{1,31}$/, 'invalid skill id');

/** 系统提示里 Skill 目录最多列出的个数(ADR 0048 第 3.1 节)。 */
export const SKILL_CATALOG_MAX = 30;

/** 插件 Skill 的全局 id。 */
export function pluginSkillId(pluginId: string, skillId: string): string {
    return `plugin.${pluginId}.${skillId}`;
}

export const SkillInfo = z.object({
    id: SkillGlobalId,
    name: pluginText(64),
    description: z.string(),
    source: z.enum(['builtin', 'plugin']),
    /** 插件 Skill 所属的插件;内置 Skill 为 null。 */
    pluginId: z.string().nullable(),
    /** 内置 Skill 看设置里的开关;插件 Skill 看所属插件是否启用。 */
    enabled: z.boolean(),
    toolSet: z.array(z.string()),
    taskTemplates: z.array(PluginSkillTaskTemplate),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

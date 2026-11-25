// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 内置 Skill(ADR 0048 第 5 节):随核心发布的三个指令包,源文件在 skills/<id>/(skill.json 与 instructions.md),
// 由 `pnpm gen:skills` 写进 generated.ts。清单按插件 Skill 的同一份 schema 校验:不运行代码,只缩小工具集。
import { type PluginSkillTaskTemplate, type PluginText, PluginSkill } from '@fatcat-ai/shared';
import { BUILTIN_SKILL_SOURCES } from './generated.js';

/** 内置 Skill:清单字段与说明原文。 */
export interface BuiltinSkill {
    id: string;
    name: PluginText;
    description: string;
    toolSet: string[];
    taskTemplates?: PluginSkillTaskTemplate[];
    instructions: string;
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = BUILTIN_SKILL_SOURCES.map(({ manifest, instructions }) => {
    const { id, name, description, toolSet, taskTemplates } = PluginSkill.parse(manifest);
    return { id, name, description, toolSet, ...(taskTemplates ? { taskTemplates } : {}), instructions };
});

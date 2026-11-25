// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Skill 界面的纯函数(ADR 0048 第 3、7 节):代理页的 Skill 状态、勾选上限、设置页的目录上限提示。
// 只用来显示;Skill 能不能用、开出哪些工具,以服务器在运行时算出的交集为准。
import { AGENT_MAX_SKILLS, SKILL_CATALOG_MAX, type SkillInfo } from '@fatcat-ai/shared';

export { AGENT_MAX_SKILLS };

/** 两个工具集条目是否有共同的工具:相同,或一方是另一方的前缀(`fs.` 覆盖 `fs.read`)。 */
export function entriesOverlap(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.endsWith('.') && b.startsWith(a)) return true;
    return b.endsWith('.') && a.startsWith(b);
}

/** Skill 的工具集与代理的工具集是否有交集(交集为空时这个代理用不了它)。 */
export function fitsToolSet(skillToolSet: readonly string[], toolSet: readonly string[]): boolean {
    return skillToolSet.some((a) => toolSet.some((b) => entriesOverlap(a, b)));
}

export type AgentSkillState = 'ok' | 'off' | 'noTools' | 'missing';

/** 代理角色里一个 Skill 的状态:不存在、已停用、工具集不含它需要的工具,或可以用。 */
export function agentSkillState(id: string, skills: readonly SkillInfo[], toolSet: readonly string[]): AgentSkillState {
    const skill = skills.find((s) => s.id === id);
    if (!skill) return 'missing';
    if (!skill.enabled) return 'off';
    return fitsToolSet(skill.toolSet, toolSet) ? 'ok' : 'noTools';
}

/** 勾选 / 取消一个 Skill;超过上限时不再加入。 */
export function toggleSkill(selected: readonly string[], id: string): string[] {
    if (selected.includes(id)) return selected.filter((x) => x !== id);
    return selected.length >= AGENT_MAX_SKILLS ? [...selected] : [...selected, id];
}

/** 启用的 Skill 是否超过系统提示目录的上限(超出的不告诉模型)。 */
export function catalogOverflow(skills: readonly SkillInfo[]): boolean {
    return skills.filter((s) => s.enabled).length > SKILL_CATALOG_MAX;
}

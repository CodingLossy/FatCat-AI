// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Skills 的运行时(ADR 0048 第 3、4、7 节):系统提示里的 Skill 目录、skill.use 的执行(与工具集取交集、
// 开启覆盖的组、说明按数据包装)、代理角色列出的 Skill 在运行开始时自动使用。只缩小,不扩大:
// Skill 不改变任何工具的风险等级、审批、预授权或 forceApproval。
import { SKILL_CATALOG_MAX, toolInSet } from '@fatcat-ai/shared';
import type { ChatMessage, ToolCall } from '@fatcat-ai/providers';
import { promptText } from '@fatcat-ai/i18n';
import type { SkillUseResult } from '@fatcat-ai/tools';
import type { LoopCtx, RunHost, RunSkill } from './common.js';
import { exclusion } from './tool-step.js';

/** Skill 的说明交给模型时的上限(与安装时的 16 KiB 检查一致;超出时截断并标出)。 */
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;

/** 运行开始时取一次已启用的 Skill;没有配置 Skill 来源时为空。 */
export function enabledSkills(host: RunHost, ownerId: string): RunSkill[] {
    try {
        return host.options.skills?.list(ownerId) ?? [];
    } catch (error) {
        host.options.onError?.(error, { runId: `skills:${ownerId}` });
        return [];
    }
}

/** Skill 的有效工具集里还剩哪些工具条目:Skill 的 `toolSet` 与当前运行工具集链的交集(只看已注册的工具)。 */
function effectiveTools(host: RunHost, ctx: LoopCtx, skill: RunSkill, ownerOnly: boolean): string[] {
    const tools = host.options.tools;
    if (!tools) return [];
    const specs = ownerOnly ? tools.specs(ctx.ownerId) : tools.specs();
    return specs
        .map((spec) => spec.name)
        .filter((name) => toolInSet(name, skill.toolSet) && exclusion(host, ctx, name) === undefined);
}

/** 本次运行能用的 Skill(交集非空),按 id 排序,最多 30 个(ADR 0048 第 3.1 节);运行开始时算一次存进 ctx.catalog。 */
export function usableSkills(host: RunHost, ctx: LoopCtx): RunSkill[] {
    return ctx.skills
        .filter((skill) => effectiveTools(host, ctx, skill, false).length > 0)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, SKILL_CATALOG_MAX);
}

/** Skill 目录行(系统提示,在按需组目录之后、时间行之前);没有可列的 Skill 时为 null。 */
export function skillCatalogLine(skills: readonly RunSkill[]): string | null {
    if (skills.length === 0) return null;
    const list = skills.map((s) => `${s.id}: ${s.description.replace(/[\r\n]+/g, ' ').trim()}`).join('; ');
    return promptText('skills.catalog', 'en', { skills: list });
}

/**
 * skill.use 的执行(ADR 0048 第 3.2 节):
 * 1. 找到已启用的 Skill,没有时报 `unknown skill: <id>`;
 * 2. 有效工具集 = Skill 的 `toolSet` ∩ 当前代理 / 任务的工具集;为空时报错,括号里的说法与 unknownToolReason 一致;
 * 3. 对本次运行开启有效工具覆盖的组(与 tools.enable 同一份状态),不写库;
 * 4. 返回说明:插件 Skill 按不可信内容处理并把会话标为读过外部内容,内置 Skill 同样包装但不标记。
 * 同一次运行里重复使用只返回 `alreadyInUse`。
 */
export function useSkill(host: RunHost, ctx: LoopCtx, id: string): SkillUseResult {
    const skill = ctx.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`unknown skill: ${id}`);
    if (ctx.usedSkills.has(id)) return { id, alreadyInUse: true };
    if (effectiveTools(host, ctx, skill, false).length === 0) {
        const label = ctx.toolSets.at(-1)?.label ?? 'agent';
        throw new Error(`unknown skill: ${id} (its tools are not in this ${label}'s tool set)`);
    }
    const raw = host.options.skills?.instructions(ctx.ownerId, id);
    if (raw === null || raw === undefined) throw new Error(`unknown skill: ${id}`);
    const bytes = new TextEncoder().encode(raw);
    const truncated = bytes.byteLength > MAX_INSTRUCTIONS_BYTES;
    const content = truncated ? new TextDecoder().decode(bytes.subarray(0, MAX_INSTRUCTIONS_BYTES)) : raw;
    const tools = host.options.tools!;
    const available = effectiveTools(host, ctx, skill, true);
    for (const name of available) ctx.activeGroups.add(tools.groupOf(name));
    ctx.usedSkills.add(id);
    if (skill.source === 'plugin' && !ctx.untrusted.seen) {
        ctx.untrusted.seen = true;
        host.options.repos.sessions.markUntrusted(ctx.sessionId);
    }
    return {
        id,
        tools: available,
        instructions: { untrusted: true, source: { kind: 'skill', ref: id }, content, truncated },
    };
}

/**
 * 代理角色列出的 Skill(ADR 0048 第 7 节):运行开始时对每个 Skill 自动调用一次 skill.use,与模型调用走同一份逻辑,
 * 作为工具调用和工具结果记在助手消息里。不存在、已停用或交集为空的 Skill 跳过,运行照常。返回 true 表示被取消。
 */
export async function autoUseSkills(
    host: RunHost,
    ctx: LoopCtx,
    ids: readonly string[],
    messages: ChatMessage[],
    runCalls: (host: RunHost, ctx: LoopCtx, calls: ToolCall[], messages: ChatMessage[]) => Promise<boolean>,
): Promise<boolean> {
    const usable = new Set(ctx.catalog.map((s) => s.id));
    const calls: ToolCall[] = ids
        .filter((id) => usable.has(id))
        .map((id, i) => ({ callId: `auto-skill-${i}`, name: 'skill.use', input: { id } }));
    if (calls.length === 0) return false;
    messages.push({ role: 'assistant', content: '', toolCalls: calls });
    return runCalls(host, ctx, calls, messages);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 模型上下文的组装:系统提示与时间行、代理人格、记忆上下文、已有摘要和最近的原文(ADR 0004、0007、0023)。
import type { Settings } from '@fatcat-ai/shared';
import { effectiveTimeZone, formatPromptTime } from '@fatcat-ai/shared';
import type { ChatMessage } from '@fatcat-ai/providers';
import type { ModelProfileRecord } from '@fatcat-ai/storage';
import { promptText, toolGroupLabel } from '@fatcat-ai/i18n';
import { DEFAULT_CONTEXT_WINDOW, planContext, SUMMARY_PREFIX, textOf, toChatMessages, transcript } from '../context.js';
import type { MemoryTurnContext, RunHost, RunSkill, StartedRun, StartRunInput } from './common.js';
import { skillCatalogLine } from './skills.js';

/** 通用系统提示;文字在提示注册表里(`system.base`,ADR 0047 第 3 节),这里保留原导出名作别名。 */
export const SYSTEM_PROMPT = promptText('system.base');

/** 系统提示的最后一行:用户时区的当前时间,精确到分钟(ADR 0023 第 4 节)。 */
export function currentTimeLine(settings: Pick<Settings, 'locale' | 'timeZone'>, nowMs: number): string {
    const time = formatPromptTime(new Date(nowMs), effectiveTimeZone(settings.timeZone), settings.locale);
    return promptText('currentTime', settings.locale, { time });
}

/** 按需组目录行(ADR 0047 第 1.4 节):`Optional tool groups …: fs (local files …), mail (e-mail).`。 */
export function groupCatalogLine(groups: readonly string[]): string {
    return promptText('tools.groupCatalog', 'en', { groups: groups.map(toolGroupLabel).join(', ') });
}

/**
 * 通用系统提示加当前时间;根运行和子运行共用(只有注册了工具时才加)。
 * groups 是能用 tools.enable 开启的按需组,非空时在时间行之前加一行目录(时间行保持在最后,ADR 0023 第 4 节);
 * skills 是本次运行能用的 Skill,非空时在按需组目录之后、时间行之前加一行 Skill 目录(ADR 0048 第 3.1 节)。
 */
export function systemMessage(
    host: RunHost,
    ownerId: string,
    groups: readonly string[] = [],
    skills: readonly RunSkill[] = [],
): ChatMessage {
    const lines = [SYSTEM_PROMPT];
    if (groups.length > 0) lines.push(groupCatalogLine(groups));
    const catalog = skillCatalogLine(skills);
    if (catalog) lines.push(catalog);
    lines.push(currentTimeLine(host.options.repos.settings.get(ownerId), host.now()));
    return { role: 'system', content: lines.join('\n') };
}

/** 本轮的记忆上下文;未配置或失败时为空,失败不影响这一轮。 */
export async function memoryFor(
    host: RunHost,
    input: StartRunInput,
    run: StartedRun & { assistantSeq: number },
    signal: AbortSignal,
): Promise<MemoryTurnContext> {
    const none = { messages: [], ids: [] };
    const { options } = host;
    if (!options.memoryContext || input.agent?.memoryScope === 'none') return none;
    const { repos } = options;
    try {
        const user = repos.messages.get(input.ownerId, run.userMessageId);
        const earlier = repos.messages
            .listBefore(input.ownerId, input.sessionId, run.assistantSeq)
            .filter((m) => m.role === 'user' && m.id !== run.userMessageId);
        return await options.memoryContext(
            {
                ownerId: input.ownerId,
                sessionId: input.sessionId,
                query: user ? textOf(user) : '',
                firstTurn: earlier.length === 0,
                contextWindow: input.profile.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                runId: run.runId,
            },
            signal,
        );
    } catch (error) {
        if (signal.aborted) throw error;
        options.onError?.(error, { runId: run.runId });
        return none;
    }
}

/**
 * 组装模型上下文:已有摘要 + 尚未被摘要覆盖、且在预算内的最近原文。
 * 超出预算的旧消息先交给 summarize 压缩成一段摘要(失败时直接丢弃),原文仍在 messages 表中。
 */
export async function buildContext(
    host: RunHost,
    ownerId: string,
    sessionId: string,
    beforeSeq: number,
    profile: ModelProfileRecord,
    signal: AbortSignal,
    memory: readonly string[] = [],
    persona = '',
    groups: readonly string[] = [],
    skills: readonly RunSkill[] = [],
): Promise<ChatMessage[]> {
    const { options } = host;
    const { repos } = options;
    const summaries = repos.summaries.list(sessionId);
    const covered = summaries.at(-1)?.toSeq ?? 0;
    const eligible = repos.messages
        .listBefore(ownerId, sessionId, beforeSeq)
        .filter((m) => m.seq > covered)
        .filter(
            (m) =>
                m.role !== 'assistant' ||
                (m.status === 'complete' && textOf(m) !== '' && !repos.messages.isSuperseded(m.id)),
        );
    const plan = planContext(eligible, profile.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    if (plan.toCompress.length > 0 && options.summarize) {
        try {
            const summary = (await options.summarize(ownerId, transcript(plan.toCompress), signal)).trim();
            if (summary) {
                const range = { fromSeq: plan.toCompress[0]!.seq, toSeq: plan.toCompress.at(-1)!.seq, summary };
                repos.summaries.add(sessionId, range);
                summaries.push(range);
            }
        } catch (error) {
            if (signal.aborted) throw error;
            options.onError?.(error, { runId: `summary:${sessionId}` });
        }
    }
    const out: ChatMessage[] = [];
    if (options.tools?.size) out.push(systemMessage(host, ownerId, groups, skills));
    // 代理的人格提示词放在通用系统提示之后;它只能补充角色,工具集与审批不由提示词决定
    if (persona.trim()) out.push({ role: 'system', content: persona.trim() });
    // digest 与记忆块是数据:放在系统提示之后、对话之前(补充设计第 4.4–4.5 节)
    for (const content of memory) out.push({ role: 'system', content });
    if (summaries.length > 0) {
        out.push({
            role: 'system',
            content: `${SUMMARY_PREFIX}\n\n${summaries.map((x) => x.summary).join('\n\n')}`,
        });
    }
    const loadImage = options.loadImage;
    out.push(
        ...(await toChatMessages(plan.recent, {
            vision: profile.vision === true,
            load: loadImage && ((id: string) => loadImage(ownerId, id)),
        })),
    );
    return out;
}

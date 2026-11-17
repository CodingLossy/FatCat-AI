// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// channel.push(ADR 0034 第 3 节):定时任务把结果推到主人自己绑定的渠道。
// external 级别,每次都需要审批,不可预授权;目标渠道只来自任务配置(ToolContext.task),模型给不了。
import type { ToolDefinition } from '@fatcat-ai/tools';

const MAX_TEXT = 4000;

export function createChannelPushTool(
    push: (ownerId: string, channelId: string, text: string) => Promise<void>,
): ToolDefinition {
    const textOf = (input: unknown): string => {
        const text = (input as { text?: unknown } | null)?.text;
        if (typeof text !== 'string' || text.trim() === '') throw new Error('text is required');
        if (text.length > MAX_TEXT) throw new Error(`text is too long (max ${MAX_TEXT} characters)`);
        return text;
    };
    return {
        name: 'channel.push',
        description:
            'Send a message to the owner through the messaging channel configured for this scheduled task. ' +
            'Only available inside scheduled tasks that have a channel output; the owner must approve every message.',
        parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: `The message text (max ${MAX_TEXT} characters).` } },
            required: ['text'],
            additionalProperties: false,
        },
        risk: 'external',
        preauthorizable: false,
        summarize(input) {
            let text: string;
            try {
                text = textOf(input);
            } catch {
                text = '';
            }
            return `Push to the owner's channel: ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`;
        },
        async execute(input, context) {
            const channelId = context.task?.channelId;
            if (!channelId) throw new Error('channel.push is only available in scheduled tasks with a channel output');
            await push(context.ownerId, channelId, textOf(input));
            return { sent: true };
        },
    };
}

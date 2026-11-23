// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { dictionaries } from '@fatcat-ai/i18n';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const Input = z.strictObject({
    group: z.string().trim().min(1).max(120),
});

/**
 * tools.enable(read,核心组):对本次运行开启一个按需工具组(ADR 0047 第 1.3 节),返回组里的工具名和一句话说明。
 * 工具本身不做事,开启由 core 通过 ToolContext.enableGroup 完成:只在本次运行内有效,不写库;
 * 组不存在或被工具集排除时报错。开启只决定工具说明是否交给模型,组内工具的风险等级、审批与预授权都不变。
 */
export function createToolsEnableTool(): ToolDefinition {
    return {
        name: 'tools.enable',
        description:
            'Turn on an optional tool group (listed under "Optional tool groups" in the system prompt) for the rest ' +
            "of this answer. Returns the group's tools; you can call them from the next step. " +
            "Enabling a group does not change which actions need the user's approval.",
        parameters: {
            type: 'object',
            properties: { group: { type: 'string', description: 'Group name, e.g. fs or mail.' } },
            required: ['group'],
            additionalProperties: false,
        },
        risk: 'read',
        activityLabel: {
            'zh-CN': dictionaries['zh-CN']['tools.activity.enable'],
            en: dictionaries.en['tools.activity.enable'],
        },
        summarize: (input) => {
            const parsed = Input.safeParse(input);
            return parsed.success ? `Enable tool group ${parsed.data.group}` : 'Enable a tool group';
        },
        async execute(input, context) {
            const { group } = Input.parse(input);
            if (!context.enableGroup) throw new Error('tool groups are not available in this run');
            return context.enableGroup(group);
        },
    };
}

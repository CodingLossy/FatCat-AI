// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

/** 右侧面板里能打开的内容;与 Web 工作台的 panelForTool 对应。 */
export const UI_PANELS = ['files', 'changes', 'mail', 'memory', 'browser'] as const;
export type UiPanel = (typeof UI_PANELS)[number];

const Input = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('open'), panel: z.enum(UI_PANELS) }),
    z.strictObject({ action: z.literal('close') }),
]);

/**
 * ui.panel(read):让工作台打开或收起右侧面板。工具本身没有任何副作用,只回显请求;
 * 真正切换面板的是看到这次调用的 Web 客户端(说话和打字都走同一条路)。
 */
export function createUiPanelTool(): ToolDefinition {
    return {
        name: 'ui.panel',
        description:
            'Open or close the side panel of the workbench window. ' +
            'Use action "open" with a panel (files, changes, mail, memory or browser) to show it, ' +
            'or action "close" to collapse the panel. It only changes what is shown; it reads and changes nothing.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['open', 'close'] },
                panel: { type: 'string', enum: [...UI_PANELS], description: 'Required when action is "open".' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        risk: 'read',
        summarize: (raw) => {
            const parsed = Input.safeParse(raw ?? {});
            if (!parsed.success) return 'Change the side panel';
            return parsed.data.action === 'open' ? `Open the ${parsed.data.panel} panel` : 'Close the side panel';
        },
        execute: async (raw) => {
            const input = Input.parse(raw ?? {});
            return input.action === 'open'
                ? { ok: true, action: 'open', panel: input.panel }
                : { ok: true, action: 'close' };
        },
    };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { defaultActivityLabel } from './activity.js';
import { ToolRegistry } from './registry.js';

const tool = (name: string, extra: object = {}) => ({
    name,
    description: 'x',
    parameters: { type: 'object' },
    risk: 'read' as const,
    summarize: () => name,
    execute: () => Promise.resolve(null),
    ...extra,
});

describe('activityLabel', () => {
    it('内置工具按名称取默认值,工具自己的优先,MCP 工具没有', () => {
        expect(defaultActivityLabel('mail.send')?.['zh-CN']).toBe('正在发送邮件…');
        expect(defaultActivityLabel('fs.read')?.en).toBe('Looking at files…');
        expect(defaultActivityLabel('mcp.notes.add')).toBeUndefined();
        const own = { 'zh-CN': '正在算账…', en: 'Doing sums…' };
        const registry = new ToolRegistry().register(
            tool('web.fetch'),
            tool('calc.sum', { activityLabel: own }),
            tool('mcp.notes.add', { source: 'mcp', server: 'notes' }),
        );
        const info = Object.fromEntries(registry.info().map((t) => [t.name, t.activityLabel]));
        expect(info['web.fetch']?.en).toBe('Reading a web page…');
        expect(info['calc.sum']).toEqual(own);
        expect(info['mcp.notes.add']).toBeUndefined();
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import type { LiveTool } from './live-turn.js';
import {
    initialPanel,
    matchCommands,
    panelForTool,
    reducePanel,
    shouldAutoClose,
    toolSummary,
    visibleToolRows,
} from './workbench-model.js';

function tool(partial: Partial<LiveTool> & Pick<LiveTool, 'callId' | 'name'>): LiveTool {
    return { input: {}, ...partial };
}

describe('RUNNING TOOLS', () => {
    it('按事件顺序排,最新的在最后;运行中、完成、失败、等待审批各有状态;超过 4 行折叠更早的', () => {
        const tools = [
            tool({ callId: 'a', name: 'fs.list', input: { path: '/proj/src' }, result: { output: {} } }),
            tool({
                callId: 'b',
                name: 'fs.read',
                input: { path: '/proj/src/a.ts' },
                result: { output: {}, error: 'denied' },
            }),
            tool({
                callId: 'c',
                name: 'fs.write',
                input: { path: '/proj/src/a.ts', content: 'x' },
                approval: { summary: 'write', decision: 'reject' },
            }),
            tool({
                callId: 'd',
                name: 'mail.send',
                input: { text: 'hello' },
                approval: { summary: 'send' },
            }),
            tool({ callId: 'e', name: 'calc.sum', input: { n: 1 } }),
        ];
        const { rows, hidden } = visibleToolRows(tools);
        expect(hidden).toBe(1);
        expect(rows.map((row) => row.callId)).toEqual(['b', 'c', 'd', 'e']);
        expect(rows.map((row) => row.status)).toEqual(['failed', 'failed', 'waiting', 'running']);
        expect(toolSummary('fs.read', { path: '/tmp/proj/test_deck.js' })).toBe('fs.read(test_deck.js)');
        expect(rows[0]?.summary).toBe('fs.read(a.ts)');
        expect(rows[3]?.summary).toBe('calc.sum');
    });
});

describe('panel follow', () => {
    it('工具调用切换面板;点导轨后固定,下一轮运行重新跟随;不认识的工具不切换', () => {
        expect(panelForTool('fs.read')).toBe('files');
        expect(panelForTool('fs.write')).toBe('changes');
        expect(panelForTool('mail.read')).toBe('mail');
        expect(panelForTool('memory.search')).toBe('memory');
        expect(panelForTool('kb.search')).toBe('memory');
        expect(panelForTool('web.fetch')).toBe('browser');
        expect(panelForTool('calc.sum')).toBeNull();

        let state = reducePanel(initialPanel(), { type: 'live', runId: 'r1', toolName: 'fs.read' });
        expect(state).toMatchObject({ panel: 'files', pinned: false, runId: 'r1' });
        state = reducePanel(state, { type: 'pin', panel: 'mail' });
        expect(state.pinned).toBe(true);
        state = reducePanel(state, { type: 'live', runId: 'r1', toolName: 'fs.write' });
        expect(state.panel).toBe('mail');
        state = reducePanel(state, { type: 'live', runId: 'r2', toolName: 'web.fetch' });
        expect(state).toMatchObject({ panel: 'browser', pinned: false, runId: 'r2' });
        state = reducePanel(state, { type: 'live', runId: 'r2', toolName: 'calc.sum' });
        expect(state.panel).toBe('browser');
    });

    it('空闲时面板收起;工具自动打开它;本轮手动收起后不再被工具打开,下一轮恢复', () => {
        let state = initialPanel();
        expect(state.open).toBe(false);
        state = reducePanel(state, { type: 'live', runId: 'r1', toolName: 'fs.read' });
        expect(state).toMatchObject({ open: true, panel: 'files', pinned: false });
        state = reducePanel(state, { type: 'close' });
        state = reducePanel(state, { type: 'live', runId: 'r1', toolName: 'mail.list' });
        expect(state).toMatchObject({ open: false, panel: 'mail' });
        state = reducePanel(state, { type: 'live', runId: 'r2', toolName: 'mail.list' });
        expect(state.open).toBe(true);
    });

    it('ui.panel 每个调用只执行一次:打开即固定,收起即清除固定;参数不合法时忽略', () => {
        const call = (callId: string, input: unknown) =>
            ({ type: 'live', runId: 'r1', toolName: 'ui.panel', callId, input }) as const;
        let state = reducePanel(initialPanel(), call('c1', { action: 'open', panel: 'memory' }));
        expect(state).toMatchObject({ open: true, panel: 'memory', pinned: true });
        // 之后的工具不会把固定的面板切走;同一个调用重渲染也不会重复执行
        state = reducePanel(state, { type: 'live', runId: 'r1', toolName: 'fs.read' });
        expect(state.panel).toBe('memory');
        state = reducePanel(state, { type: 'close' });
        state = reducePanel(state, call('c1', { action: 'open', panel: 'memory' }));
        expect(state.open).toBe(false);
        state = reducePanel(state, call('c2', { action: 'open', panel: 'terminal' }));
        expect(state.open).toBe(false);
        state = reducePanel(
            reducePanel(state, call('c3', { action: 'open', panel: 'mail' })),
            call('c4', { action: 'close' }),
        );
        expect(state).toMatchObject({ open: false, pinned: false });
    });

    it('只有运行结束、未固定、没有待审批时才自动收起', () => {
        const open = reducePanel(initialPanel(), { type: 'live', runId: 'r1', toolName: 'fs.read' });
        expect(shouldAutoClose(open, true, 0)).toBe(false);
        expect(shouldAutoClose(open, false, 1)).toBe(false);
        expect(shouldAutoClose(open, false, 0)).toBe(true);
        const pinned = reducePanel(open, { type: 'pin', panel: 'files' });
        expect(shouldAutoClose(pinned, false, 0)).toBe(false);
        expect(reducePanel(pinned, { type: 'auto-close' }).open).toBe(true);
        expect(reducePanel(open, { type: 'auto-close' }).open).toBe(false);
        expect(shouldAutoClose(initialPanel(), false, 0)).toBe(false);
    });

    it('命令按名称和关键词过滤,空查询保留全部', () => {
        const commands = [
            { id: 'files', label: '切换到文件', keywords: 'files panel' },
            { id: 'settings', label: '打开设置', keywords: 'settings' },
        ];
        expect(matchCommands(commands, '').map((c) => c.id)).toEqual(['files', 'settings']);
        expect(matchCommands(commands, 'FILE').map((c) => c.id)).toEqual(['files']);
        expect(matchCommands(commands, '设置').map((c) => c.id)).toEqual(['settings']);
        expect(matchCommands(commands, '没有')).toEqual([]);
    });
});

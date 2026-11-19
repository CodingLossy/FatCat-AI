// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import type { LiveTool } from './live-turn.js';
import {
    INITIAL_PANEL,
    buildFilesModel,
    followTool,
    parseFsList,
    pinPanel,
    runningRows,
    startRun,
} from './workbench.js';

const tool = (callId: string, name: string, extra: Partial<LiveTool> = {}): LiveTool => ({
    callId,
    name,
    input: {},
    ...extra,
});
const untrusted = (ref: string, content: string) => ({ untrusted: true, source: { kind: 'file', ref }, content });

describe('workbench', () => {
    it('RUNNING TOOLS 最多四行,更早的折叠成 +N,状态来自事件', () => {
        const tools = [
            tool('1', 'fs.list', { input: { path: '/a' }, result: { output: '' } }),
            tool('2', 'fs.read', { result: { output: '', error: 'nope' } }),
            tool('3', 'mail.send', { approval: { summary: 'Send mail to bob' } }),
            tool('4', 'web.fetch', { input: { url: 'https://example.com' } }),
            tool('5', 'fs.write', { approval: { summary: 'Write x', decision: 'reject' } }),
        ];
        const { rows, more } = runningRows(tools);
        expect(more).toBe(1);
        expect(rows.map((r) => r.status)).toEqual(['error', 'approval', 'running', 'error']);
        expect(rows[2]?.detail).toBe('https://example.com');
    });

    it('面板跟随文件工具切换,手动点击导轨后固定,下一轮运行再解除', () => {
        let state = followTool(INITIAL_PANEL, 'fs.read');
        expect(state.panel).toBe('files');
        state = pinPanel('chat');
        expect(followTool(state, 'fs.list').panel).toBe('chat');
        expect(followTool(INITIAL_PANEL, 'mail.read').panel).toBe('chat');
        state = startRun(state);
        expect(followTool(state, 'fs.list').panel).toBe('files');
    });

    it('文件树由 fs.list 结果构建,预览取 fs.read 的文本,不可信格式不符的结果被忽略', () => {
        const model = buildFilesModel([
            tool('1', 'fs.list', { result: { output: untrusted('/p', 'dir\tsrc\nfile\ta.ts\t12\nbogus line') } }),
            tool('2', 'fs.list', { result: { output: untrusted('/p/src', 'file\tb.ts\t3') } }),
            tool('3', 'fs.read', { result: { output: untrusted('/p/src/b.ts', 'one\ntwo') } }),
            tool('4', 'fs.read', { result: { output: 'plain string' } }),
        ]);
        expect(parseFsList('dir\tx\nfile\ty\t5')).toEqual([
            { kind: 'dir', name: 'x' },
            { kind: 'file', name: 'y', size: 5 },
        ]);
        expect(model.roots).toHaveLength(1);
        const src = model.roots[0]?.children?.find((c) => c.name === 'src');
        expect(src?.children?.map((c) => c.name)).toEqual(['b.ts']);
        expect(model.latest?.lines).toEqual(['one', 'two']);
    });
});

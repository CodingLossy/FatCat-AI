// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import type { LiveTool } from './live-turn.js';
import {
    INITIAL_PANEL,
    PREVIEW_MAX_CHARS,
    buildFilesModel,
    followTool,
    parseFsList,
    pinPanel,
    runningRows,
    shortcutHint,
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

    it('Windows 反斜杠路径、根目录 / 、重复 fs.list 以最后一次为准、超长内容标记截断', () => {
        const win = buildFilesModel([
            tool('1', 'fs.list', { result: { output: untrusted('C:\\work', 'dir\tsrc') } }),
            tool('2', 'fs.list', { result: { output: untrusted('C:\\work\\src', 'file\ta.ts') } }),
        ]);
        expect(win.roots[0]?.name).toBe('work');
        expect(win.roots[0]?.children?.[0]?.children?.[0]?.path).toBe('C:\\work\\src\\a.ts');

        const slash = buildFilesModel([tool('1', 'fs.list', { result: { output: untrusted('/', 'dir\tetc') } })]);
        expect(slash.roots[0]?.path).toBe('/');
        expect(slash.roots[0]?.children?.[0]?.path).toBe('/etc');

        const again = buildFilesModel([
            tool('1', 'fs.list', { result: { output: untrusted('/p', 'file\told.ts') } }),
            tool('2', 'fs.list', { result: { output: untrusted('/p', 'file\tnew.ts') } }),
        ]);
        expect(again.roots[0]?.children?.map((c) => c.name)).toEqual(['new.ts']);

        const big = buildFilesModel([
            tool('1', 'fs.read', { result: { output: untrusted('/p/big.txt', 'x'.repeat(PREVIEW_MAX_CHARS + 10)) } }),
        ]);
        expect(big.latest?.truncated).toBe(true);
        expect(big.latest?.lines.join('').length).toBe(PREVIEW_MAX_CHARS);
    });

    it('搜索框快捷键提示按平台显示', () => {
        expect(shortcutHint('MacIntel')).toBe('⌘K');
        expect(shortcutHint('Win32')).toBe('Ctrl K');
    });
});

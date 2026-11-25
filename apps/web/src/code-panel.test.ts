// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    buildCodeView,
    insidePath,
    isCodeTool,
    parseGitDiff,
    parseLog,
    projectOfTool,
    relativeTo,
    showFor,
    splitShow,
} from './code-panel.js';
import type { LiveTool } from './live-turn.js';
import { panelForTool, initialPanel, reducePanel } from './workbench-model.js';

const projects = [
    { id: 'p1', name: 'FatCat-AI', path: 'E:\\projects\\FatCat-AI' },
    { id: 'p2', name: 'Other', path: '/home/u/other' },
];
const untrusted = (ref: string, content: string, truncated = false) => ({
    untrusted: true,
    source: { kind: 'code', ref },
    content,
    truncated,
});
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LOG = ['#\thash\tauthor\ttime\tsubject', `1\t${SHA.slice(0, 7)}\tShy\t2026-11-24T10:00:00+08:00\tfix: x`].join(
    '\n',
);
const SHOW = [
    `commit ${SHA}`,
    'Author: Shy',
    'Date:   2026-11-24T10:00:00+08:00',
    '',
    'fix: x',
    '',
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@ export',
    ' keep',
    '-old',
    '+new',
    '+more',
].join('\n');

let seq = 0;
const tool = (name: string, input: unknown, output?: unknown, extra: Partial<LiveTool> = {}): LiveTool => ({
    callId: `c${++seq}`,
    name,
    input,
    ...(output !== undefined ? { result: { output } } : {}),
    ...extra,
});

describe('代码面板:哪些调用打开它(ADR 0049 第 4 节)', () => {
    it('git.* 与 code.run 打开;fs 工具只有路径在已登记项目里才打开;按字符串判断,不区分大小写和分隔符', () => {
        expect(panelForTool('git.log', { project: 'x' }, projects)).toBe('code');
        expect(panelForTool('code.run', {}, projects)).toBe('code');
        expect(panelForTool('fs.read', { path: 'e:/projects/fatcat-ai/src/a.ts' }, projects)).toBe('code');
        expect(panelForTool('fs.write', { path: '/home/u/other/b.ts' }, projects)).toBe('code');
        expect(panelForTool('fs.read', { path: '/home/u/other-2/b.ts' }, projects)).toBe('files');
        expect(panelForTool('fs.write', { path: '/elsewhere/b.ts' }, projects)).toBe('changes');
        expect(panelForTool('fs.read', { path: 'E:\\projects\\FatCat-AI\\a.ts' })).toBe('files');
        expect(insidePath('/a/b', '/a/b')).toBe(true);
        expect(insidePath('/a/bc', '/a/b')).toBe(false);
        expect(isCodeTool({ name: 'fs.move', input: { from: '/x', to: '/home/u/other/y' } }, projects)).toBe(true);
    });

    it('reducePanel:项目内的 fs.write 自动打开代码面板;ui.panel 也能打开 code', () => {
        const live = reducePanel(initialPanel(), {
            type: 'live',
            runId: 'r1',
            toolName: 'fs.write',
            callId: 'c1',
            input: { path: '/home/u/other/a.ts' },
            projects,
        });
        expect(live).toMatchObject({ panel: 'code', open: true, pinned: false });
        const ui = reducePanel(initialPanel(), {
            type: 'live',
            runId: 'r1',
            toolName: 'ui.panel',
            callId: 'c2',
            input: { action: 'open', panel: 'code' },
        });
        expect(ui).toMatchObject({ panel: 'code', open: true, pinned: true });
    });

    it('项目按 project 参数(id 或名字,不区分大小写)或 fs 路径找到', () => {
        expect(projectOfTool({ name: 'git.show', input: { project: 'fatcat-ai' } }, projects)?.id).toBe('p1');
        expect(projectOfTool({ name: 'git.show', input: { project: 'p2' } }, projects)?.id).toBe('p2');
        expect(projectOfTool({ name: 'git.show', input: { project: 'nope' } }, projects)).toBeNull();
        expect(relativeTo('E:\\projects\\FatCat-AI\\src\\a.ts', 'E:\\projects\\FatCat-AI')).toBe('src\\a.ts');
        expect(relativeTo('/x/y', '/home')).toBe('/x/y');
    });
});

describe('代码面板:内容只来自工具结果', () => {
    it('parseLog 跳过表头和不像提交的行;parseGitDiff 区分文件头、元信息、增删和上下文', () => {
        expect(parseLog(`${LOG}\nnot a row\n2\tzzz\ta\tb\tc`)).toEqual([
            { n: 1, hash: SHA.slice(0, 7), author: 'Shy', time: '2026-11-24T10:00:00+08:00', subject: 'fix: x' },
        ]);
        const view = splitShow(SHOW);
        expect(view.sha).toBe(SHA);
        expect(view.header).toContain('fix: x');
        expect(view.lines.map((l) => l.kind)).toEqual([
            'file',
            'meta',
            'meta',
            'meta',
            'hunk',
            'ctx',
            'del',
            'add',
            'add',
        ]);
        expect(view.lines[0]!.text).toBe('src/a.ts');
        expect(view.lines.find((l) => l.kind === 'add')).toMatchObject({ newNo: 2, text: 'new' });
        // 没有计数的 hunk 头(@@ -1 +1 @@)也能算出行号
        expect(parseGitDiff('diff --git a/x b/x\n@@ -3 +3 @@\n-a\n+b')[2]).toMatchObject({ kind: 'del', oldNo: 3 });
    });

    it('控制字符与双向字符换成可见标记;超过 500 行时截断并标明', () => {
        const evil = splitShow(`commit ${SHA}\n\nsubject \u202Eevil\u0007\n`);
        expect(evil.header).toContain('\\u202e');
        expect(evil.header).toContain('\\u0007');
        expect(evil.header.includes('\u202E') || evil.header.includes('\u0007')).toBe(false);
        const long = splitShow(
            `diff --git a/x b/x\n@@ -1 +1,600 @@\n${Array.from({ length: 600 }, (_, i) => `+${i}`).join('\n')}`,
        );
        expect(long.clipped).toBe(true);
        expect(long.lines.length).toBeLessThanOrEqual(500);
    });

    it('buildCodeView:提交列表、打开过的提交、最近的差异与测试输出;换项目时清空', () => {
        const tools = [
            tool('git.log', { project: 'FatCat-AI' }, untrusted('FatCat-AI:log', LOG)),
            tool('git.show', { project: 'FatCat-AI', nth: 1 }, untrusted('FatCat-AI:HEAD', SHOW)),
            tool(
                'git.diff',
                { project: 'FatCat-AI' },
                { ...untrusted('FatCat-AI:HEAD', ''), omittedFiles: ['big.bin'] },
            ),
            tool('code.run', { project: 'FatCat-AI', command: 'test', args: ['--filter=core'] }),
        ];
        const view = buildCodeView(tools, projects);
        expect(view.project?.name).toBe('FatCat-AI');
        expect(view.commits).toHaveLength(1);
        expect(showFor(view, SHA.slice(0, 7))?.view.sha).toBe(SHA);
        expect(showFor(view, 'ffffff0')).toBeNull();
        expect(view.latest).toMatchObject({ kind: 'diff', title: 'HEAD' });
        expect(view.latest?.kind === 'diff' && view.latest.view.omittedFiles).toEqual(['big.bin']);
        expect(view.run).toMatchObject({ state: 'running', command: 'test --filter=core' });

        const other = buildCodeView(
            [...tools, tool('git.log', { project: 'Other' }, untrusted('Other:log', LOG))],
            projects,
        );
        expect(other.project?.id).toBe('p2');
        expect(other.run).toBeNull();
        expect(other.shows.size).toBe(0);
    });

    it('code.run:等待审批、拒绝、退出码、超时;输出按不可信内容取末尾', () => {
        const waiting = tool('code.run', { project: 'p1', command: 'test' }, undefined, {
            approval: { summary: 's' },
        });
        expect(buildCodeView([waiting], projects).run?.state).toBe('waiting');
        const rejected = tool('code.run', { project: 'p1', command: 'test' }, undefined, {
            approval: { summary: 's', decision: 'reject' },
        });
        expect(buildCodeView([rejected], projects).run?.state).toBe('rejected');
        const out = (exitCode: number, extra = {}) =>
            tool(
                'code.run',
                { project: 'p1', command: 'test' },
                {
                    command: 'pnpm test',
                    exitCode,
                    durationMs: 1234,
                    output: untrusted('FatCat-AI:test', 'line\n'.repeat(700) + 'tests ok'),
                    ...extra,
                },
            );
        const done = buildCodeView([out(0)], projects).run!;
        expect(done).toMatchObject({
            state: 'done',
            exitCode: 0,
            command: 'pnpm test',
            durationMs: 1234,
            clipped: true,
        });
        expect(done.output.endsWith('tests ok')).toBe(true);
        expect(done.output.split('\n').length).toBeLessThanOrEqual(500);
        expect(buildCodeView([out(1)], projects).run?.state).toBe('failed');
        expect(buildCodeView([out(1, { timedOut: true })], projects).run?.timedOut).toBe(true);
        // 不是不可信内容包装的输出不显示
        const raw = tool('code.run', { project: 'p1', command: 'test' }, { exitCode: 0, output: 'plain' });
        expect(buildCodeView([raw], projects).run?.output).toBe('');
    });

    it('项目内的 fs.write(审批中)与 fs.read 也显示;失败的 git 调用不改变内容', () => {
        const write = tool('fs.write', { path: '/home/u/other/a.ts', content: 'x' }, undefined, {
            approval: { summary: 's' },
        });
        expect(buildCodeView([write], projects).latest).toMatchObject({ kind: 'write', path: '/home/u/other/a.ts' });
        const read = tool('fs.read', { path: '/home/u/other/a.ts' }, untrusted('a.ts', 'hello'));
        expect(buildCodeView([read], projects).latest).toMatchObject({ kind: 'file', text: 'hello' });
        const failed: LiveTool = { ...tool('git.log', { project: 'Other' }), result: { output: null, error: 'boom' } };
        expect(buildCodeView([failed], projects).commits).toEqual([]);
    });
});

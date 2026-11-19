// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import type { LiveTool } from './live-turn.js';
import { buildWorkspace, clipPreview, languageOf, latestWrite, markControls } from './file-workspace.js';

function listed(path: string, content: string): LiveTool {
    return {
        callId: path,
        name: 'fs.list',
        input: { path },
        result: {
            output: { untrusted: true, source: { kind: 'file', ref: path }, content, truncated: false },
        },
    };
}

describe('file workspace', () => {
    it('用 fs.list 和 fs.read 的返回路径建树,预览用返回的文本,并标出搜索命中的行', () => {
        const tools: LiveTool[] = [
            listed('/work/proj', 'dir\tsrc\nfile\tREADME.md\t20'),
            listed('/work/proj/src', 'file\tdeck.js\t100\nfile\tmain.js\t40'),
            {
                callId: 'search',
                name: 'fs.search',
                input: { path: '/work/proj', query: 'timeout' },
                result: {
                    output: {
                        untrusted: true,
                        source: { kind: 'file', ref: '/work/proj' },
                        content: 'src/deck.js:27\tconst timeout = 20000',
                        truncated: false,
                    },
                },
            },
            {
                callId: 'read',
                name: 'fs.read',
                input: { path: 'src/deck.js' },
                result: {
                    output: {
                        untrusted: true,
                        source: { kind: 'file', ref: '/work/proj/src/deck.js' },
                        content: 'const timeout = 20000\n',
                        truncated: false,
                    },
                },
            },
        ];
        const workspace = buildWorkspace(tools);
        expect(workspace.rootLabel).toBe('work/proj');
        expect(workspace.roots.map((node) => node.name)).toEqual(['src', 'README.md']);
        const src = workspace.roots.find((node) => node.name === 'src');
        expect(src?.children.map((node) => node.name)).toEqual(['deck.js', 'main.js']);
        expect(workspace.selectedPath).toBe('/work/proj/src/deck.js');
        const preview = workspace.previews.get('/work/proj/src/deck.js');
        expect(preview?.text).toBe('const timeout = 20000\n');
        expect(preview?.highlightLine).toBe(27);
        expect(languageOf('/work/proj/src/deck.js')).toBe('javascript');
        expect(languageOf('/work/proj/README.md')).toBe('markdown');
        expect(languageOf('/work/proj/Makefile')).toBeNull();
    });

    it('双向字符换成可见标记,预览先截到 500 行和 64 KiB;写入在没有旧版本时整段作为新内容', () => {
        const hidden = `safe\u202Etxt`;
        expect(markControls(hidden)).toBe('safe\\u202etxt');
        expect(markControls('a\nb\tc')).toBe('a\nb\tc');

        const many = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
        const clipped = clipPreview(many);
        expect(clipped.clipped).toBe(true);
        expect(clipped.text.split('\n')).toHaveLength(500);
        expect(clipPreview('short').clipped).toBe(false);
        const wide = '字'.repeat(40_000);
        expect(clipPreview(wide).clipped).toBe(true);
        expect(new TextEncoder().encode(clipPreview(wide).text).byteLength).toBeLessThanOrEqual(64 * 1024);

        const write: LiveTool = {
            callId: 'w',
            name: 'fs.write',
            input: { path: '/work/proj/src/deck.js', content: 'const timeout = 25000\n' },
            approval: { summary: 'write' },
        };
        expect(latestWrite([write])).toMatchObject({
            path: '/work/proj/src/deck.js',
            text: 'const timeout = 25000\n',
            pending: true,
            failed: false,
        });
    });
});

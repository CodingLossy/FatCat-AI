// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockedExtension, checkOpenUrl, createSystemOpenTool, type OpenTarget } from './builtin/system-open.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = {
    ownerId: 'o1',
    sessionId: 's1',
    runId: 'r1',
    userMessageId: 'u1',
    assistantMessageId: 'a1',
} as ToolContext;

let base = '';
let root = '';
let outside = '';
const posix = process.platform !== 'win32';

beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fatcat-open-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'notes.pdf'), 'x');
    writeFileSync(join(root, 'setup.exe'), 'x');
    writeFileSync(join(root, 'report.pdf.exe'), 'x');
    writeFileSync(join(outside, 'secret.pdf'), 'x');
    writeFileSync(join(outside, 'tool.exe'), 'x');
    if (posix) {
        writeFileSync(join(root, 'run-me'), '#!/bin/sh');
        chmodSync(join(root, 'run-me'), 0o755);
        symlinkSync(join(outside, 'secret.pdf'), join(root, 'link-out.pdf'));
        symlinkSync(join(outside, 'tool.exe'), join(root, 'innocent.pdf'));
    }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function tool(opened: OpenTarget[] = [], enabled = true) {
    return createSystemOpenTool({
        enabled: () => enabled,
        roots: () => [root],
        host: {
            open: async (target) => {
                opened.push(target);
            },
        },
    });
}

describe('system.open', () => {
    it('风险 external、每次审批、不能预授权、设置里默认关闭', () => {
        const t = tool([], false);
        expect(t.risk).toBe('external');
        expect(t.preauthorizable).toBe(false);
        expect(t.forceApproval?.({ url: 'https://example.com/' }, ctx)).toBe(true);
        expect(t.enabledFor?.('o1')).toBe(false);
        expect(tool().enabledFor?.('o1')).toBe(true);
    });

    it('网址:只允许 https / http / mailto,不带凭据;其他协议在审批前拒绝', () => {
        const t = tool();
        for (const ok of ['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com']) {
            expect(t.precheck?.({ url: ok }, ctx)).toBeNull();
        }
        for (const bad of [
            'file:///etc/passwd',
            'javascript:alert(1)',
            'ms-settings:privacy',
            'vscode://file/x',
            'steam://run/1',
            'search-ms:query=x',
            'data:text/html,hi',
            'https://user:pass@example.com/',
            'not a url',
        ]) {
            expect(t.precheck?.({ url: bad }, ctx), bad).not.toBeNull();
        }
        expect(() => checkOpenUrl('smb://host/share')).toThrow();
    });

    it('参数:url 和 path 只能给一个,不接受其他字段(没有参数、工作目录、环境变量)', () => {
        const t = tool();
        expect(t.precheck?.({}, ctx)).not.toBeNull();
        expect(t.precheck?.({ url: 'https://a.example/', path: join(root, 'notes.pdf') }, ctx)).not.toBeNull();
        expect(t.precheck?.({ path: join(root, 'notes.pdf'), args: ['--x'] }, ctx)).not.toBeNull();
        expect(t.precheck?.({ path: join(root, 'notes.pdf'), cwd: '/' }, ctx)).not.toBeNull();
    });

    it('文件:必须在授权目录内、存在、是文件;程序和脚本按扩展名拒绝', () => {
        const t = tool();
        expect(t.precheck?.({ path: join(root, 'notes.pdf') }, ctx)).toBeNull();
        expect(t.precheck?.({ path: join(outside, 'secret.pdf') }, ctx)).toMatch(/outside/);
        expect(t.precheck?.({ path: join(root, '..', 'outside', 'secret.pdf') }, ctx)).not.toBeNull();
        expect(t.precheck?.({ path: join(root, 'missing.pdf') }, ctx)).not.toBeNull();
        expect(t.precheck?.({ path: join(root, 'folder') }, ctx)).toMatch(/folders/);
        expect(t.precheck?.({ path: join(root, 'setup.exe') }, ctx)).toMatch(/never opened/);
        expect(t.precheck?.({ path: join(root, 'report.pdf.exe') }, ctx)).toMatch(/never opened/);
        for (const ext of ['EXE', 'ps1', 'sh', 'app', 'lnk', 'AppImage', 'dmg', 'jar', 'hta']) {
            expect(blockedExtension(`a.${ext}`), ext).not.toBeNull();
        }
        expect(blockedExtension('a.pdf')).toBeNull();
        expect(blockedExtension('Makefile')).toBeNull();
    });

    it.skipIf(!posix)('符号链接指向目录之外或指向程序时拒绝;有可执行位的文件拒绝', () => {
        const t = tool();
        expect(t.precheck?.({ path: join(root, 'link-out.pdf') }, ctx)).toMatch(/outside/);
        expect(t.precheck?.({ path: join(root, 'run-me') }, ctx)).toMatch(/executable/);
        // innocent.pdf → outside/tool.exe:先因越界被拒
        expect(t.precheck?.({ path: join(root, 'innocent.pdf') }, ctx)).not.toBeNull();
    });

    it('执行:交给宿主的是解析后的真实路径或规范化网址;批准后再校验一次', async () => {
        const opened: OpenTarget[] = [];
        const t = tool(opened);
        await t.execute({ path: join(root, 'notes.pdf') }, ctx);
        await t.execute({ url: 'https://example.com' }, ctx);
        expect(opened).toEqual([
            { kind: 'file', path: join(root, 'notes.pdf') },
            { kind: 'url', url: 'https://example.com/' },
        ]);
        writeFileSync(join(root, 'later.pdf'), 'x');
        expect(t.precheck?.({ path: join(root, 'later.pdf') }, ctx)).toBeNull();
        rmSync(join(root, 'later.pdf'));
        await expect(t.execute({ path: join(root, 'later.pdf') }, ctx)).rejects.toThrow();
        expect(opened).toHaveLength(2);
    });

    it('没有桌面客户端时返回 desktop_unavailable,不会自己启动进程', async () => {
        const t = createSystemOpenTool({ enabled: () => true, roots: () => [root] });
        await expect(t.execute({ url: 'https://example.com/' }, ctx)).rejects.toMatchObject({
            code: 'desktop_unavailable',
        });
    });

    it('审批卡片显示解析后的路径;长查询串带警示', () => {
        const t = tool();
        expect(t.summarize({ path: join(root, 'notes.pdf') }, ctx)).toContain(join(root, 'notes.pdf'));
        expect(t.warnings?.({ url: `https://a.example/?q=${'x'.repeat(300)}` }, ctx)).toHaveLength(1);
        expect(t.warnings?.({ url: 'https://a.example/' }, ctx)).toEqual([]);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文件工具的路径逃逸测试(ADR 0011):词法规则在任何系统上都测;依赖文件系统的 Windows 用例只在 Windows 上跑。
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    checkLexical,
    createFsTools,
    decide,
    isFilesystemRoot,
    isWithin,
    normalizeRoot,
    PathError,
    prepareRemember,
    resolveInRoots,
    type ToolContext,
    type ToolDefinition,
} from './index.js';

const isWindows = process.platform === 'win32';
const ctx: ToolContext = {
    ownerId: 'owner',
    sessionId: 's',
    runId: 'r',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

describe('词法检查(Windows 规则在所有系统上都测)', () => {
    it.each([
        ['C:\\docs\\file.txt:secret', /alternate data streams/],
        ['C:\\docs\\file.txt::$DATA', /alternate data streams/],
        ['docs\\a:b', /alternate data streams/],
        ['\\\\?\\C:\\Windows\\win.ini', /\\\\\?\\/],
        ['\\\\.\\PhysicalDrive0', /\\\\\?\\/],
        ['//?/C:/Windows', /\\\\\?\\/],
        ['\\\\server\\share\\x', /UNC/],
        ['//server/share/x', /UNC/],
        ['C:\\docs\\CON', /reserved device name/],
        ['C:\\docs\\nul.txt', /reserved device name/],
        ['C:\\docs\\com1', /reserved device name/],
        ['C:\\docs\\LPT9.log', /reserved device name/],
        ['C:\\docs\\CONIN$', /reserved device name/],
        ['C:\\docs\\secret.', /ends with a dot or space/],
        ['C:\\docs\\secret ', /ends with a dot or space/],
        ['C:\\docs\\a<b', /does not allow/],
        ['C:\\docs\\a?b', /does not allow/],
        ['', /empty/],
        ['C:\\docs\\a\0b', /NUL/],
        ['x'.repeat(5000), /too long/],
    ])('Windows 拒绝 %s', (raw, error) => {
        expect(() => checkLexical(raw, 'win32')).toThrow(error);
    });

    it('Windows 允许普通路径;Linux 上冒号与设备名是普通字符', () => {
        expect(() => checkLexical('C:\\Users\\me\\Docs\\notes.md', 'win32')).not.toThrow();
        expect(() => checkLexical('D:/Projects/FatCat-AI/../x', 'win32')).not.toThrow();
        expect(() => checkLexical('/home/u/a:b/CON', 'linux')).not.toThrow();
        expect(() => checkLexical('/home/u/a\0b', 'linux')).toThrow(/NUL/);
    });

    it('包含关系在分隔符边界上判断;Windows 与 macOS 不区分大小写', () => {
        expect(isWithin('C:\\Docs\\a.md', 'c:\\docs', 'win32')).toBe(true);
        expect(isWithin('C:\\DOCS', 'c:\\docs\\', 'win32')).toBe(true);
        expect(isWithin('C:\\Docs2\\a.md', 'C:\\Docs', 'win32')).toBe(false);
        expect(isWithin('C:\\Docs\\..\\x', 'C:\\Docs', 'win32')).toBe(false);
        expect(isWithin('/home/u/Docs/a', '/home/u/docs', 'linux')).toBe(false);
        expect(isWithin('/home/u/docs/a', '/home/u/docs', 'linux')).toBe(true);
        expect(isWithin('/home/u/docs-private', '/home/u/docs', 'linux')).toBe(false);
        expect(isWithin('/Users/u/Docs/a', '/users/u/docs', 'darwin')).toBe(true);
        expect(isFilesystemRoot('C:\\', 'win32')).toBe(true);
        expect(isFilesystemRoot('/', 'linux')).toBe(true);
        expect(isFilesystemRoot('/home', 'linux')).toBe(false);
    });
});

describe('真实文件系统', () => {
    let base: string;
    let root: string;
    let outside: string;

    beforeEach(() => {
        base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-fs-')));
        root = path.join(base, 'Root');
        outside = path.join(base, 'Outside');
        mkdirSync(path.join(root, 'sub'), { recursive: true });
        mkdirSync(outside);
        writeFileSync(path.join(root, 'notes.md'), '第一行\nhello world\n');
        writeFileSync(path.join(root, 'sub', 'deep.txt'), 'deep hello');
        writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
        mkdirSync(path.join(base, 'Root2'));
        writeFileSync(path.join(base, 'Root2', 'x.txt'), 'x');
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    const tools = () => {
        const all = createFsTools({ roots: () => [root] });
        return Object.fromEntries(all.map((t) => [t.name, t])) as Record<string, ToolDefinition>;
    };

    it('授权目录内的绝对与相对路径可以解析;.. 逃逸、相邻目录、不存在的路径被拒绝', () => {
        expect(resolveInRoots(path.join(root, 'notes.md'), [root]).path).toBe(path.join(root, 'notes.md'));
        expect(resolveInRoots('sub/deep.txt', [root]).path).toBe(path.join(root, 'sub', 'deep.txt'));
        expect(() => resolveInRoots(path.join(root, '..', 'Outside', 'secret.txt'), [root])).toThrow(/outside/);
        expect(() => resolveInRoots('../Outside/secret.txt', [root])).toThrow(/outside/);
        expect(() => resolveInRoots(path.join(base, 'Root2', 'x.txt'), [root])).toThrow(/outside/);
        expect(() => resolveInRoots(path.join(root, 'missing.txt'), [root])).toThrow(/does not exist/);
        expect(resolveInRoots(path.join(root, 'new.txt'), [root], { allowMissing: true }).path).toBe(
            path.join(root, 'new.txt'),
        );
        expect(() => resolveInRoots(path.join(root, 'nope', 'new.txt'), [root], { allowMissing: true })).toThrow(
            /parent folder does not exist/,
        );
        expect(() => resolveInRoots('notes.md', [root, outside])).toThrow(/must be absolute/);
        expect(() => resolveInRoots('notes.md', [])).toThrow(/no folder has been authorized/);
    });

    it('符号链接 / junction 指向授权目录之外:读写都被拒绝', async () => {
        // Windows 上用 junction(不需要管理员权限);其他系统用目录符号链接
        symlinkSync(outside, path.join(root, 'escape'), isWindows ? 'junction' : 'dir');
        expect(() => resolveInRoots(path.join(root, 'escape', 'secret.txt'), [root])).toThrow(/outside/);
        await expect(
            tools()['fs.read']!.execute({ path: path.join(root, 'escape', 'secret.txt') }, ctx),
        ).rejects.toThrow(/outside/);
        await expect(
            tools()['fs.write']!.execute({ path: path.join(root, 'escape', 'planted.txt'), content: 'x' }, ctx),
        ).rejects.toThrow(/outside/);
        expect(existsSync(path.join(outside, 'planted.txt'))).toBe(false);
        // 遍历时不进入链接
        const listed = (await tools()['fs.search']!.execute({ path: root, query: 'secret' }, ctx)) as {
            content: string;
        };
        expect(listed.content).toBe('');
    });

    it.skipIf(isWindows)('文件符号链接:写入时不跟随链接', async () => {
        symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        await expect(
            tools()['fs.write']!.execute({ path: path.join(root, 'link.txt'), content: 'pwned', overwrite: true }, ctx),
        ).rejects.toThrow(/outside|link/);
        expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    });

    it('授权目录本身被换成指向别处的链接时,以真实位置为准', () => {
        const linkRoot = path.join(base, 'LinkRoot');
        symlinkSync(outside, linkRoot, isWindows ? 'junction' : 'dir');
        // 授权的是 LinkRoot,它实际指向 Outside:Outside 内的文件可读,Root 内的不行
        expect(resolveInRoots(path.join(linkRoot, 'secret.txt'), [linkRoot]).path).toBe(
            path.join(outside, 'secret.txt'),
        );
        expect(() => resolveInRoots(path.join(root, 'notes.md'), [linkRoot])).toThrow(/outside/);
    });

    it('fs.list / fs.read / fs.search 返回不可信内容;读取二进制文件报错', async () => {
        const t = tools();
        const list = (await t['fs.list']!.execute({ path: root }, ctx)) as { untrusted: boolean; content: string };
        expect(list.untrusted).toBe(true);
        const entries = list.content.split('\n');
        expect(entries).toHaveLength(2);
        expect(entries).toContain('dir\tsub');
        expect(entries.find((e) => e.startsWith('file\t'))).toMatch(/^file\tnotes\.md\t\d+$/);
        const read = (await t['fs.read']!.execute({ path: 'notes.md' }, ctx)) as {
            content: string;
            truncated: boolean;
        };
        expect(read).toMatchObject({ content: '第一行\nhello world\n', truncated: false });
        const partial = (await t['fs.read']!.execute({ path: 'notes.md', offset: 10 }, ctx)) as { content: string };
        expect(partial.content).toBe('hello world\n');
        const found = (await t['fs.search']!.execute({ path: root, query: 'HELLO' }, ctx)) as { content: string };
        expect(found.content.split('\n').sort()).toEqual(
            ['notes.md:2\thello world', `${path.join('sub', 'deep.txt')}:1\tdeep hello`].sort(),
        );
        writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
        await expect(t['fs.read']!.execute({ path: 'bin.dat' }, ctx)).rejects.toThrow(/binary/);
        await expect(t['fs.read']!.execute({ path: 'sub' }, ctx)).rejects.toThrow(/not a file/);
        await expect(t['fs.list']!.execute({ path: 'notes.md' }, ctx)).rejects.toThrow(/not a folder/);
    });

    it('fs.write 原子写入、默认不覆盖、拒绝写目录;fs.move 不能移动授权目录、不能移进自己', async () => {
        const t = tools();
        await expect(t['fs.write']!.execute({ path: 'out.md', content: '# 标题' }, ctx)).resolves.toMatchObject({
            replaced: false,
        });
        expect(readFileSync(path.join(root, 'out.md'), 'utf8')).toBe('# 标题');
        await expect(t['fs.write']!.execute({ path: 'out.md', content: 'x' }, ctx)).rejects.toThrow(/overwrite/);
        await expect(
            t['fs.write']!.execute({ path: 'out.md', content: 'v2', overwrite: true }, ctx),
        ).resolves.toMatchObject({
            replaced: true,
        });
        await expect(t['fs.write']!.execute({ path: 'sub', content: 'x', overwrite: true }, ctx)).rejects.toThrow(
            /folder/,
        );
        await expect(
            t['fs.write']!.execute({ path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) }, ctx),
        ).rejects.toThrow(/too large/);
        expect(readFileSync(path.join(root, 'out.md'), 'utf8')).toBe('v2');

        await expect(t['fs.move']!.execute({ from: 'out.md', to: 'sub/out.md' }, ctx)).resolves.toMatchObject({
            to: path.join(root, 'sub', 'out.md'),
        });
        await expect(t['fs.move']!.execute({ from: root, to: path.join(root, 'sub', 'x') }, ctx)).rejects.toThrow(
            /authorized folder cannot be moved/,
        );
        await expect(t['fs.move']!.execute({ from: 'sub', to: 'sub/inner' }, ctx)).rejects.toThrow(/into itself/);
        await expect(t['fs.move']!.execute({ from: 'notes.md', to: 'sub/deep.txt' }, ctx)).rejects.toThrow(/overwrite/);
        await expect(
            t['fs.move']!.execute({ from: 'notes.md', to: path.join(outside, 'stolen.md') }, ctx),
        ).rejects.toThrow(/outside/);
        expect(existsSync(path.join(outside, 'stolen.md'))).toBe(false);
    });

    it('预授权:路径先 realpath 规范化;只能按授权目录内的已有文件夹预授权;匹配时比较规范化路径', () => {
        const write = tools()['fs.write']!;
        expect(prepareRemember(write, { scope: 'always' }, ctx)).toEqual({
            error: 'the tool fs.write can only be pre-authorized with a pathPrefix constraint',
        });
        const messy = path.join(root, 'sub', '..', 'sub', '.');
        const prepared = prepareRemember(write, { scope: 'always', constraint: { pathPrefix: messy } }, ctx);
        expect(prepared).toEqual({ ok: { scope: 'always', constraint: { pathPrefix: path.join(root, 'sub') } } });
        expect(prepareRemember(write, { scope: 'always', constraint: { pathPrefix: outside } }, ctx)).toMatchObject({
            error: expect.stringMatching(/outside/) as string,
        });
        expect(
            prepareRemember(write, { scope: 'always', constraint: { pathPrefix: path.join(root, 'notes.md') } }, ctx),
        ).toMatchObject({ error: expect.stringMatching(/folder/) as string });

        const preauth = {
            id: 'p',
            toolName: 'fs.write',
            scope: 'always' as const,
            sessionId: null,
            constraint: { pathPrefix: path.join(root, 'sub') },
            createdAt: '',
            lastUsedAt: null,
        };
        expect(decide(write, { path: 'sub/new.md', content: '' }, ctx, [preauth])).toMatchObject({
            action: 'run',
            decision: 'preauthorized',
        });
        expect(decide(write, { path: 'notes.md', content: '' }, ctx, [preauth])).toEqual({ action: 'ask' });
        expect(decide(write, { path: 'sub/../../Outside/x', content: '' }, ctx, [preauth])).toEqual({ action: 'ask' });

        const move = tools()['fs.move']!;
        const movePreauth = { ...preauth, toolName: 'fs.move' };
        writeFileSync(path.join(root, 'sub', 'a.txt'), 'a');
        expect(decide(move, { from: 'sub/a.txt', to: 'sub/b.txt' }, ctx, [movePreauth])).toMatchObject({
            action: 'run',
        });
        expect(decide(move, { from: 'notes.md', to: 'sub/n.md' }, ctx, [movePreauth])).toEqual({ action: 'ask' });
    });

    it('授权目录:必须是存在的绝对路径文件夹,不能是整个盘或文件系统根', () => {
        expect(normalizeRoot(path.join(root, 'sub', '..'))).toBe(root);
        expect(() => normalizeRoot('relative/dir')).toThrow(/absolute/);
        expect(() => normalizeRoot(path.join(root, 'missing'))).toThrow(/does not exist/);
        expect(() => normalizeRoot(path.join(root, 'notes.md'))).toThrow(/not a folder/);
        expect(() => normalizeRoot(path.parse(root).root)).toThrow(/whole drive|filesystem root/);
        expect(() => normalizeRoot(path.join(root, 'x\0'))).toThrow(PathError);
    });

    describe.runIf(isWindows)('Windows 特有的逃逸', () => {
        it('大小写不同的路径指向同一个授权目录;返回真实大小写', () => {
            const upper = path.join(root.toUpperCase(), 'NOTES.MD');
            expect(resolveInRoots(upper, [root]).path).toBe(path.join(root, 'notes.md'));
            expect(resolveInRoots(path.join(root.toLowerCase(), 'notes.md'), [root.toUpperCase()]).path).toBe(
                path.join(root, 'notes.md'),
            );
        });

        it('备用数据流、设备名、结尾的点与空格、UNC 与 \\\\?\\ 前缀都被拒绝', async () => {
            const t = tools();
            for (const raw of [
                `${path.join(root, 'notes.md')}:hidden`,
                path.join(root, 'CON'),
                path.join(root, 'nul.txt'),
                path.join(root, 'notes.md.'),
                path.join(root, 'notes.md '),
                `\\\\?\\${path.join(root, 'notes.md')}`,
                `\\\\localhost\\${root.replace(':', '$')}\\notes.md`,
            ]) {
                await expect(
                    t['fs.write']!.execute({ path: raw, content: 'x', overwrite: true }, ctx),
                    raw,
                ).rejects.toThrow(PathError);
            }
            expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('第一行\nhello world\n');
        });

        it('8.3 短文件名:展开成长名后再判断,指向授权目录之外的短名被拒绝', (testCtx) => {
            const longOutside = path.join(base, 'OutsideWithAVeryLongName');
            mkdirSync(longOutside);
            writeFileSync(path.join(longOutside, 'secret.txt'), 's');
            let short = '';
            try {
                // /s + 外层引号:cmd 原样解析整条命令;windowsVerbatimArguments 避免 Node 再转义一次引号
                short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${longOutside}") do @echo %~sI"`], {
                    encoding: 'utf8',
                    windowsVerbatimArguments: true,
                }).stdout.trim();
            } catch {
                // cmd 不可用
            }
            if (!short || short.toLowerCase() === longOutside.toLowerCase()) {
                testCtx.skip(`this volume does not generate 8.3 short names (${longOutside})`);
                return;
            }
            // 短名展开为长名:等价路径被识别为同一个位置
            expect(resolveInRoots(path.join(short, 'secret.txt'), [longOutside]).path).toBe(
                path.join(longOutside, 'secret.txt'),
            );
            // 授权 Root 时,用短名指向 Outside 的路径仍在外面
            expect(() => resolveInRoots(path.join(short, 'secret.txt'), [root])).toThrow(/outside/);
            // 授权目录以短名给出时,也规范化为长名
            expect(normalizeRoot(short)).toBe(longOutside);
        });
    });
});

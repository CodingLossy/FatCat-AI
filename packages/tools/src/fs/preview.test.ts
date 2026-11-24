// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../types.js';
import { createFsTools } from './tools.js';
import { PREVIEW_MAX_LINES, previewWrite } from './preview.js';

let root: string;
let outside: string;
beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fc-prev-')));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'fc-out-')));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

describe('previewWrite', () => {
    it('shows a hunk with context for a modified file', () => {
        const file = path.join(root, 'a.txt');
        writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
        const p = previewWrite('a.txt', file, 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n');
        expect(p.state).toBe('modified');
        expect(p.text).toBe('@@ -1,7 +1,7 @@\n one\n two\n three\n-four\n+FOUR\n five\n six\n seven');
    });

    it('shows every line as added for a new file and says unchanged for identical content', () => {
        const file = path.join(root, 'n.txt');
        expect(previewWrite('n.txt', file, 'x\ny\n')).toMatchObject({
            state: 'created',
            text: '@@ -0,0 +1,2 @@\n+x\n+y',
        });
        writeFileSync(file, 'x\ny\n');
        expect(previewWrite('n.txt', file, 'x\ny\n')).toMatchObject({ state: 'unchanged', text: '' });
    });

    it('refuses to render a diff it cannot bound instead of showing a partial one', () => {
        const file = path.join(root, 'big.txt');
        writeFileSync(file, 'a\n'.repeat(PREVIEW_MAX_LINES + 1));
        expect(previewWrite('big.txt', file, 'b\n').state).toBe('too-large');
        writeFileSync(file, Buffer.from([0x61, 0, 0x62]));
        expect(previewWrite('big.txt', file, 'b\n').state).toBe('too-large');
    });

    it('truncates long output and says so', () => {
        const file = path.join(root, 't.txt');
        const p = previewWrite('t.txt', file, Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n'));
        expect(p.truncated).toBe(true);
        expect(p.text.split('\n').length).toBeLessThanOrEqual(500);
    });
});

describe.skipIf(process.platform === 'win32')('🔒 a FIFO never blocks the preview or the write', () => {
    it('is refused without being opened', () => {
        const fifo = path.join(root, 'p');
        execFileSync('mkfifo', [fifo]);
        const started = Date.now();
        expect(() => previewWrite('p', fifo, 'hello\n')).toThrow(/not a regular file/);
        expect(Date.now() - started).toBeLessThan(1000);
        const tool = createFsTools({ roots: () => [root] }).find((t) => t.name === 'fs.write')!;
        expect(
            tool.preview!({ path: fifo, content: 'x', overwrite: true }, {
                ownerId: 'o',
                sessionId: 's',
            } as ToolContext),
        ).toBeUndefined();
    });

    it('execute refuses to overwrite a FIFO, with or without overwrite: true, and does not hang', async () => {
        const fifo = path.join(root, 'q');
        execFileSync('mkfifo', [fifo]);
        const tool = createFsTools({ roots: () => [root] }).find((t) => t.name === 'fs.write')!;
        const context = { ownerId: 'o', sessionId: 's' } as ToolContext;
        const started = Date.now();
        for (const overwrite of [true, false]) {
            await expect(tool.execute({ path: fifo, content: 'x', overwrite }, context)).rejects.toThrow();
        }
        await expect(tool.execute({ path: fifo, content: 'x', overwrite: true }, context)).rejects.toThrow(
            /not a regular file/,
        );
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

// Windows 没有 mkfifo;对应的是命名管道 \\.\pipe\…:向它写会一直等对端读取。
// 这类路径在词法检查里就被拒绝(ADR 0011),预览和执行都不打开它,也不会挂住。
describe.runIf(process.platform === 'win32')('🔒 a Windows named pipe never blocks the preview or the write', () => {
    it('is refused before it is opened, quickly, and the pipe server never sees a connection', async () => {
        const name = `\\\\.\\pipe\\fatcat-test-${process.pid}-${Date.now()}`;
        let connections = 0;
        const server = createServer(() => connections++);
        await new Promise<void>((resolve) => server.listen(name, resolve));
        try {
            const tool = createFsTools({ roots: () => [root] }).find((t) => t.name === 'fs.write')!;
            const context = { ownerId: 'o', sessionId: 's' } as ToolContext;
            const started = Date.now();
            // 正斜杠写法 //./pipe/… 指向同一个管道
            for (const target of [name, name.replaceAll('\\', '/')]) {
                expect(tool.preview!({ path: target, content: 'x', overwrite: true }, context)).toBeUndefined();
                for (const overwrite of [true, false]) {
                    await expect(tool.execute({ path: target, content: 'x', overwrite }, context)).rejects.toThrow(
                        /paths are not allowed/,
                    );
                }
            }
            expect(Date.now() - started).toBeLessThan(2000);
            expect(connections).toBe(0);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('🔒 fs.write preview stays inside the approved roots', () => {
    const ctx = { ownerId: 'o', sessionId: 's' } as ToolContext;
    const tool = () => createFsTools({ roots: () => [root] }).find((t) => t.name === 'fs.write')!;

    it('gives a path relative to the root and never writes anything', () => {
        writeFileSync(path.join(root, 'a.txt'), 'old\n');
        const p = tool().preview!({ path: path.join(root, 'a.txt'), content: 'new\n', overwrite: true }, ctx);
        expect(p).toMatchObject({ path: 'a.txt', state: 'modified' });
        expect(p?.text).toContain('-old');
        expect(p?.text).toContain('+new');
    });

    it('returns nothing for a path outside the roots, a link target, or bad input', () => {
        writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
        expect(tool().preview!({ path: path.join(outside, 'secret.txt'), content: 'x' }, ctx)).toBeUndefined();
        mkdirSync(path.join(root, 'd'));
        symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        expect(
            tool().preview!({ path: path.join(root, 'link.txt'), content: 'x', overwrite: true }, ctx),
        ).toBeUndefined();
        expect(tool().preview!({ path: path.join(root, 'a.txt'), content: 5 }, ctx)).toBeUndefined();
    });
});

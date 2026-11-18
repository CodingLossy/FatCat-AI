// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTar, makeTgz, type TarEntry } from './fixtures/tgz.js';
import { PluginPackageError } from './package.js';
import { extractTgz, TAR_LIMITS } from './tar.js';

const dirs: string[] = [];
const dest = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-tar-'));
    dirs.push(dir);
    return join(dir, 'out');
};
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reject = async (entries: TarEntry[], pattern: RegExp, limits = TAR_LIMITS) => {
    const error = await extractTgz(makeTgz(entries), dest(), limits).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginPackageError);
    expect((error as PluginPackageError).code).toBe('plugin_package_invalid');
    expect((error as Error).message).toMatch(pattern);
};

describe('extractTgz', () => {
    it('extracts regular files and directories, including long paths split over the ustar prefix', async () => {
        const out = dest();
        const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
        await extractTgz(
            makeTgz([
                { name: './plugin.json', data: '{"a":1}' },
                { name: 'dist/', type: '5' },
                { name: 'dist/server.js', data: 'x'.repeat(1000) },
                { name: 'empty.txt' },
                { name: long, data: 'deep' },
            ]),
            out,
        );
        expect(readFileSync(join(out, 'plugin.json'), 'utf8')).toBe('{"a":1}');
        expect(readFileSync(join(out, 'dist', 'server.js'), 'utf8')).toHaveLength(1000);
        expect(readFileSync(join(out, 'empty.txt'), 'utf8')).toBe('');
        expect(readFileSync(join(out, long), 'utf8')).toBe('deep');
    });

    it.each([
        ['a symbolic link', { name: 'link', type: '2', linkName: '/etc/passwd' }, /symbolic link/],
        ['a hard link', { name: 'link', type: '1', linkName: 'plugin.json' }, /hard link/],
        ['a device file', { name: 'dev', type: '3' }, /character device/],
        ['an absolute path', { name: '/etc/evil', data: 'x' }, /absolute/],
        ['a parent directory', { name: 'a/../../evil', data: 'x' }, /\.\./],
        ['a drive letter', { name: 'C:evil.js', data: 'x' }, /drive letter/],
        ['a Windows reserved name', { name: 'dist/NUL.txt', data: 'x' }, /reserved Windows name/],
        ['a trailing dot', { name: 'a.js.', data: 'x' }, /trailing dot/],
        ['an over-long path', { name: `${'d'.repeat(19)}/`.repeat(12) + 'file.js', data: 'x' }, /too long/],
        ['a GNU long name', { name: '././@LongLink', type: 'L', data: 'x' }, /GNU long name/],
    ] as [string, TarEntry, RegExp][])('rejects %s', async (_label, entry, pattern) => {
        await reject([{ name: 'plugin.json', data: '{}' }, entry], pattern);
    });

    it('rejects duplicate paths, also when they differ only in case', async () => {
        await reject(
            [
                { name: 'a.js', data: '1' },
                { name: 'a.js', data: '2' },
            ],
            /duplicate/,
        );
        await reject(
            [
                { name: 'README', data: '1' },
                { name: 'readme', data: '2' },
            ],
            /duplicate/,
        );
        await reject(
            [
                { name: 'a', data: '1' },
                { name: 'a/b', data: '2' },
            ],
            /parent path is a file/,
        );
    });

    it('rejects pax headers that rename an entry but ignores harmless ones', async () => {
        const pax = (record: string) => {
            const body = ` ${record}\n`;
            let length = body.length + 1;
            while (String(length).length + body.length !== length) length = String(length).length + body.length;
            return `${length}${body}`;
        };
        await reject(
            [
                { name: 'pax', type: 'x', data: pax('path=../../evil') },
                { name: 'a', data: '1' },
            ],
            /pax header/,
        );
        const out = dest();
        await extractTgz(
            makeTgz([
                { name: 'pax', type: 'x', data: pax('mtime=1700000000') },
                { name: 'a', data: '1' },
            ]),
            out,
        );
        expect(readdirSync(out)).toEqual(['a']);
    });

    it('enforces the file count, per-file and total size limits', async () => {
        const limits = { ...TAR_LIMITS, files: 2, fileBytes: 100, totalBytes: 150 };
        await reject([{ name: 'a' }, { name: 'b' }, { name: 'c' }], /too many/, limits);
        await reject([{ name: 'a', data: 'x'.repeat(101) }], /file is too large/, limits);
        await reject(
            [
                { name: 'a', data: 'x'.repeat(100) },
                { name: 'b', data: 'x'.repeat(60) },
            ],
            /too many or too large/,
            limits,
        );
    });

    it('aborts a decompression bomb by compression ratio', async () => {
        const out = dest();
        const bomb = gzipSync(makeTar([{ name: 'zeros.bin', data: Buffer.alloc(5 * 1024 * 1024) }]));
        expect(bomb.length * 100).toBeLessThan(5 * 1024 * 1024);
        await expect(extractTgz(bomb, out)).rejects.toThrow(/decompression bomb/);
    });

    it('rejects broken input: not gzip, truncated, bad checksum, data after the end marker', async () => {
        await expect(extractTgz(Buffer.from('not a tarball'), dest())).rejects.toThrow(/not a valid .tgz/);
        const full = makeTar([{ name: 'a', data: 'x'.repeat(2000) }]);
        await expect(extractTgz(gzipSync(full.subarray(0, 700)), dest())).rejects.toThrow(/truncated/);
        const bad = Buffer.from(makeTar([{ name: 'a', data: 'x' }]));
        bad[0] = bad[0]! ^ 0xff;
        await expect(extractTgz(gzipSync(bad), dest())).rejects.toThrow(/checksum/);
        const trailing = Buffer.concat([makeTar([{ name: 'a', data: 'x' }]), Buffer.from('junk')]);
        await expect(extractTgz(gzipSync(trailing), dest())).rejects.toThrow(/after the end marker/);
        expect(existsSync(dest())).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readAll, readHidden, type Ctx } from './io.js';

function ctx(stdin: Ctx['stdin'], stderr: Ctx['stderr'] = new PassThrough()): Ctx {
    return {
        env: {},
        stdin,
        stdout: new PassThrough(),
        stderr,
        onInterrupt: () => () => undefined,
    };
}

describe('piped and typed secrets', () => {
    it('readAll drops a leading UTF-8 BOM so a PowerShell pipe is not part of the secret', async () => {
        const stdin = Readable.from([
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('secret line\r\n', 'utf8')]),
        ]);
        const text = await readAll(ctx(stdin));
        expect(text.replace(/\r?\n$/, '')).toBe('secret line');
        expect(text.includes('\uFEFF')).toBe(false);
    });

    it('readHidden drops a leading BOM and still ends the line at CR', async () => {
        const raw = new PassThrough();
        const stdin = raw as Ctx['stdin'];
        stdin.isTTY = true;
        stdin.setRawMode = () => undefined;
        const pending = readHidden(ctx(stdin), 'Password: ');
        raw.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('correct horse\r', 'utf8')]));
        await expect(pending).resolves.toBe('correct horse');
    });
});

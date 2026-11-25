// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 附件目录按账户分子目录的搬迁(ADR 0053 第 10 节):按数据库行复制,全部复制完才写标记、删旧文件;
// 上次搬到一半时接着搬;没搬时读取回落到旧位置。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentFiles, LAYOUT_MARKER, migrateAttachmentLayout } from './attachment-files.js';
import { createTestServer, type TestServer } from './test-helpers.js';

let s: TestServer;
let dataDir: string;
beforeEach(async () => {
    s = await createTestServer();
    dataDir = await mkdtemp(join(tmpdir(), 'fatcat-attachments-'));
});
afterEach(async () => {
    await s.cleanup();
    await rm(dataDir, { recursive: true, force: true });
});

const png = { mediaType: 'image/png' as const, bytes: 3, sha256: 'x', fileName: 'a.png' };

describe('附件目录按账户搬迁', () => {
    it('按行搬到账户子目录;中途留下的状态接着搬;完成后写标记、删旧文件,再次启动什么都不做', async () => {
        const admin = s.repos.owners.create({ username: 'admin', passwordHash: 'x' }).id;
        const member = s.repos.owners.create({ username: 'member', passwordHash: 'x' }).id;
        const a = s.repos.attachments.create(admin, png).id;
        const b = s.repos.attachments.create(member, png).id;
        const c = s.repos.attachments.create(member, png).id;
        const lost = s.repos.attachments.create(member, png).id;
        const dir = join(dataDir, 'attachments');
        await mkdir(dir, { recursive: true });
        for (const id of [a, b, c]) await writeFile(join(dir, id), id);
        // 没有行的旧文件留给每天的清理
        await writeFile(join(dir, '01JXRPHANXRPHANXRPHANXRPHA'), 'orphan');
        // 上次搬到一半:b 已经复制过去,旧文件还在
        await mkdir(join(dir, member));
        await writeFile(join(dir, member, b), b);

        // 搬之前,读取回落到旧位置
        const files = createAttachmentFiles(dataDir);
        expect(Buffer.from((await files.read(admin, a))!).toString()).toBe(a);

        expect(await migrateAttachmentLayout(dataDir, s.repos)).toEqual({ moved: 2, missing: 1, alreadyDone: false });
        expect(await readFile(join(dir, admin, a), 'utf8')).toBe(a);
        expect(await readFile(join(dir, member, c), 'utf8')).toBe(c);
        for (const id of [a, b, c]) expect(existsSync(join(dir, id))).toBe(false);
        expect(existsSync(join(dir, '01JXRPHANXRPHANXRPHANXRPHA'))).toBe(true);
        expect(existsSync(join(dir, LAYOUT_MARKER))).toBe(true);
        expect(existsSync(join(dir, member, `${c}.part`))).toBe(false);
        // 别的账户读不到:路径由账户 id 决定
        expect(await files.read(admin, c)).toBeNull();
        expect(Buffer.from((await files.read(member, c))!).toString()).toBe(c);
        expect(lost).toBeTruthy();

        expect(await migrateAttachmentLayout(dataDir, s.repos)).toEqual({ moved: 0, missing: 0, alreadyDone: true });
    });

    it('新上传的附件直接写进账户子目录;不合法的 id 不拼进路径', async () => {
        const files = createAttachmentFiles(dataDir);
        const owner = s.repos.owners.create({ username: 'o', passwordHash: 'x' }).id;
        const id = s.repos.attachments.create(owner, png).id;
        await files.write(owner, id, Buffer.from('hi'));
        expect(existsSync(join(dataDir, 'attachments', owner, id))).toBe(true);
        expect(await files.list()).toEqual([{ ownerId: owner, id, mtimeMs: expect.any(Number) }]);
        await expect(files.read('../etc', id)).rejects.toThrow(/invalid account id/);
        await expect(files.write(owner, '../x', Buffer.from(''))).rejects.toThrow(/invalid attachment id/);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ADR 0045 第 2 节:变更日志迁移 0021 与触发器。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories } from './repos.js';

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-sync-'));
    dirs.push(dir);
    const conn = openDatabase(join(dir, 'db.sqlite'));
    await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
    const repos = createRepositories(conn);
    const owner = repos.owners.create({ username: 'o', passwordHash: 'h' });
    return { conn, repos, owner: owner.id, dir };
}

describe('变更日志', () => {
    it('每个实体只保留最近一次变化;删除会话级联为消息墓碑;seq 只增', async () => {
        const { repos, owner, conn } = await fresh();
        const session = repos.sessions.create(owner, { title: 'a' });
        const msg = repos.messages.append(owner, session.id, {
            role: 'user',
            parts: [{ type: 'text', text: 'hi' }],
            status: 'complete',
        });
        const first = repos.sync.changesAfter(owner, 0, 100, []);
        // 追加消息会同时更新会话的 last_message_at,所以消息在前、会话在后
        expect(first.map((r) => [r.kind, r.entityId, r.deleted])).toEqual([
            ['message', msg.id, false],
            ['session', session.id, false],
        ]);

        // 再改一次会话:同一实体只有一行,seq 变大
        repos.sessions.update(owner, session.id, { title: 'b' });
        const second = repos.sync.changesAfter(owner, first.at(-1)!.seq, 100, []);
        expect(second.map((r) => [r.kind, r.entityId])).toEqual([['session', session.id]]);
        expect(conn.sqlite.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({ n: 2 });

        // kinds 过滤
        expect(repos.sync.changesAfter(owner, 0, 100, ['message']).map((r) => r.kind)).toEqual(['message']);

        // 删除会话:会话与消息都变成墓碑(外键级联也会触发)
        repos.sessions.delete(owner, session.id);
        const after = repos.sync.changesAfter(owner, 0, 100, []);
        expect(after.every((r) => r.deleted)).toBe(true);
        expect(after.find((r) => r.kind === 'message')).toMatchObject({ entityId: msg.id, sessionId: session.id });
    });
});

describe('migration 0021', () => {
    it('在已有数据的库上只新增 change_log,先备份,回填已有会话与消息,外键检查干净', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m21-'));
        dirs.push(dir);
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 20),
                { backupDir: join(dir, 'backups') },
            );
            const repos = createRepositories(conn);
            const owner = repos.owners.create({ username: 'o', passwordHash: 'h' }).id;
            const session = repos.sessions.create(owner, { title: 'old' });
            repos.messages.append(owner, session.id, {
                role: 'user',
                parts: [{ type: 'text', text: 'hi' }],
                status: 'complete',
            });
            const tables = () =>
                (conn.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
                    .map((r) => r.name)
                    .sort();
            const before = tables();

            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual([21]);
            expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
            expect(tables().filter((n) => !before.includes(n))).toEqual(['change_log']);
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);

            const log = createRepositories(conn).sync.changesAfter(owner, 0, 100, []);
            expect(log.map((r) => r.kind).sort()).toEqual(['message', 'session']);
        } finally {
            conn.close();
        }
    });
});

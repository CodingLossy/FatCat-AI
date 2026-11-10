// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Connection } from './db.js';
import { checksum, migrate, MigrationError, type Migration } from './migrate.js';
import { migrations } from './migrations/index.js';

let dir: string;
let conns: Connection[];

function open(name = 'db.sqlite'): Connection {
    const conn = openDatabase(join(dir, name));
    conns.push(conn);
    return conn;
}

const tableExists = (conn: Connection, name: string) =>
    conn.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aip-migrate-'));
    conns = [];
});

afterEach(() => {
    for (const c of conns) c.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('连接参数', () => {
    it('每个新连接都开启外键,文件库使用 WAL', async () => {
        const a = open();
        await migrate(a.sqlite, migrations);
        const b = open();
        for (const c of [a, b]) {
            expect(c.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
            expect(c.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
            expect(c.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
            // 页缓存 4 MiB(ADR 0005 第 2 节、ADR 0018 第 7 节)
            expect(c.sqlite.pragma('cache_size', { simple: true })).toBe(-4000);
        }
    });

    it(':memory: 库同样开启外键', () => {
        const c = openDatabase(':memory:');
        conns.push(c);
        expect(c.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(c.sqlite.pragma('cache_size', { simple: true })).toBe(-4000);
    });
});

describe('migrate', () => {
    it('空库迁移到最新,再次执行无待执行迁移', async () => {
        const c = open();
        const first = await migrate(c.sqlite, migrations, { backupDir: join(dir, 'backups') });
        expect(first.applied).toEqual(migrations.map((m) => m.id));
        expect(first.backupPath).toBeNull(); // 空库无需备份
        const second = await migrate(c.sqlite, migrations, { backupDir: join(dir, 'backups') });
        expect(second.applied).toEqual([]);
        const row = c.sqlite.prepare('SELECT checksum FROM schema_migrations WHERE id = 1').get() as {
            checksum: string;
        };
        expect(row.checksum).toBe(checksum(migrations[0]!.sql));
        expect(c.sqlite.pragma('foreign_key_check')).toEqual([]);
    });

    it('已执行的迁移被修改时拒绝启动', async () => {
        const c = open();
        await migrate(c.sqlite, [{ id: 1, name: 'a', sql: 'CREATE TABLE a (x)' }]);
        await expect(migrate(c.sqlite, [{ id: 1, name: 'a', sql: 'CREATE TABLE a (y)' }])).rejects.toThrow(
            /modified after it was applied/,
        );
    });

    it('库中有本版本不认识的迁移时拒绝启动', async () => {
        const c = open();
        await migrate(c.sqlite, [
            { id: 1, name: 'a', sql: 'CREATE TABLE a (x)' },
            { id: 2, name: 'b', sql: 'CREATE TABLE b (x)' },
        ]);
        await expect(migrate(c.sqlite, [{ id: 1, name: 'a', sql: 'CREATE TABLE a (x)' }])).rejects.toThrow(
            /unknown to this version/,
        );
    });

    it('迁移 id 必须从 1 连续', async () => {
        const c = open();
        await expect(migrate(c.sqlite, [{ id: 2, name: 'b', sql: 'SELECT 1' }])).rejects.toThrow(/contiguous/);
    });

    it('失败时整批回滚,并保留迁移前的备份', async () => {
        const c = open();
        const m1: Migration = { id: 1, name: 'one', sql: "CREATE TABLE one (x); INSERT INTO one VALUES ('keep');" };
        await migrate(c.sqlite, [m1], { backupDir: join(dir, 'backups') });

        const bad: Migration[] = [
            m1,
            { id: 2, name: 'two', sql: 'CREATE TABLE two (x)' },
            { id: 3, name: 'three', sql: 'CREATE TABLE broken (' },
        ];
        const error = await migrate(c.sqlite, bad, { backupDir: join(dir, 'backups') }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        const backupPath = (error as MigrationError).backupPath;
        expect(backupPath).not.toBeNull();
        expect(existsSync(backupPath!)).toBe(true);
        expect((error as Error).message).toContain('migration 2 (two) failed');

        // 2 和 3 在同一事务中,全部回滚
        expect(tableExists(c, 'two')).toBe(false);
        expect(c.sqlite.prepare('SELECT max(id) AS m FROM schema_migrations').get()).toEqual({ m: 1 });

        // 备份可以打开,且包含迁移前的数据
        const restored = openDatabase(backupPath!);
        conns.push(restored);
        expect(restored.sqlite.prepare('SELECT x FROM one').get()).toEqual({ x: 'keep' });
    });

    it('只保留最近 N 份备份', async () => {
        const c = open();
        let ms = Date.parse('2026-11-03T00:00:00Z');
        const now = () => new Date((ms += 1000));
        const list: Migration[] = [];
        for (let i = 1; i <= 4; i++) {
            list.push({ id: i, name: `m${i}`, sql: `CREATE TABLE t${i} (x)` });
            await migrate(c.sqlite, [...list], { backupDir: join(dir, 'backups'), keepBackups: 2, now });
        }
        // 第 1 次是空库不备份,之后 3 次各备份一份,只保留 2 份
        expect(readdirSync(join(dir, 'backups'))).toHaveLength(2);
    });

    describe('rebuild 迁移', () => {
        const base: Migration = {
            id: 1,
            name: 'base',
            sql: `CREATE TABLE parent (id TEXT PRIMARY KEY);
                  CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT);
                  INSERT INTO parent VALUES ('p1');
                  INSERT INTO child VALUES ('c1', 'p1');`,
        };
        const rebuildSql = (extra = '') => `
            CREATE TABLE child_new (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);
            INSERT INTO child_new SELECT id, parent_id FROM child;
            ${extra}
            DROP TABLE child;
            ALTER TABLE child_new RENAME TO child;`;

        it('关闭外键执行,完成后恢复并生效', async () => {
            const c = open();
            await migrate(c.sqlite, [base]);
            await migrate(c.sqlite, [base, { id: 2, name: 'fk', sql: rebuildSql(), rebuild: true }]);
            expect(c.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
            c.sqlite.prepare("DELETE FROM parent WHERE id = 'p1'").run();
            expect(c.sqlite.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 0 });
        });

        it('foreign_key_check 有违规时回滚', async () => {
            const c = open();
            await migrate(c.sqlite, [base]);
            const orphan = "INSERT INTO child_new VALUES ('c2', 'missing');";
            await expect(
                migrate(c.sqlite, [base, { id: 2, name: 'fk', sql: rebuildSql(orphan), rebuild: true }]),
            ).rejects.toThrow(/foreign_key_check/);
            expect(c.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
            expect(tableExists(c, 'child_new')).toBe(false);
            expect(c.sqlite.prepare('SELECT max(id) AS m FROM schema_migrations').get()).toEqual({ m: 1 });
        });
    });
});

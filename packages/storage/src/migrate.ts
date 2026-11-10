// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertForeignKeysOn, StorageError, type Sqlite } from './db.js';

export interface Migration {
    /** 从 1 开始连续递增。 */
    id: number;
    name: string;
    sql: string;
    /**
     * 需要「建新表 → 拷数据 → 删旧表 → 改名」的迁移。PRAGMA foreign_keys 在事务内修改无效,
     * 因此这类迁移单独执行:先关外键,在自己的事务内执行并做 foreign_key_check,最后恢复外键(ADR 0005)。
     */
    rebuild?: boolean;
    /**
     * 数据迁移:在 sql 之后、同一个事务中执行(例如需要生成 ULID 的回填,ADR 0007 第 5.3 节)。
     * 与 sql 一样,发布后不得修改;只能使用迁移文件自己的代码,不能调用会演进的仓储。
     */
    data?: (sqlite: Sqlite, context: { now: () => Date }) => void;
}

export interface MigrateOptions {
    /** 有待执行的迁移且库中已有数据时,先备份到此目录;':memory:' 库不备份。 */
    backupDir?: string;
    /** 保留的备份份数,默认 5。 */
    keepBackups?: number;
    now?: () => Date;
}

export interface MigrateResult {
    applied: number[];
    backupPath: string | null;
}

export class MigrationError extends StorageError {
    constructor(
        message: string,
        readonly backupPath: string | null,
        options?: { cause?: unknown },
    ) {
        super(backupPath ? `${message} (backup: ${backupPath})` : message, options);
    }
}

const JOURNAL_TABLE = 'schema_migrations';

export function checksum(sql: string): string {
    return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function validateList(migrations: readonly Migration[]): void {
    migrations.forEach((m, i) => {
        if (m.id !== i + 1) {
            throw new StorageError(`migration ids must be contiguous from 1; found ${m.id} at position ${i + 1}`);
        }
    });
}

function ensureJournal(sqlite: Sqlite): void {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
    )`);
}

function appliedMigrations(sqlite: Sqlite): Map<number, { name: string; checksum: string }> {
    const rows = sqlite.prepare(`SELECT id, name, checksum FROM ${JOURNAL_TABLE} ORDER BY id`).all() as {
        id: number;
        name: string;
        checksum: string;
    }[];
    return new Map(rows.map((r) => [r.id, { name: r.name, checksum: r.checksum }]));
}

function hasUserTables(sqlite: Sqlite): boolean {
    const row = sqlite
        .prepare(
            `SELECT count(*) AS n FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${JOURNAL_TABLE}'`,
        )
        .get() as { n: number };
    return row.n > 0;
}

function timestampForFile(date: Date): string {
    return date
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

async function backup(sqlite: Sqlite, dir: string, firstPending: number, now: Date, keep: number): Promise<string> {
    mkdirSync(dir, { recursive: true });
    const file = `db-${timestampForFile(now)}-pre-${String(firstPending).padStart(4, '0')}.sqlite`;
    const path = join(dir, file);
    await sqlite.backup(path);
    const backups = readdirSync(dir)
        .filter((f) => /^db-.*\.sqlite$/.test(f))
        .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
        rmSync(join(dir, old), { force: true });
    }
    return path;
}

/**
 * 执行待执行的迁移:校验已执行迁移的校验和 → 必要时在线备份 → 普通迁移在一个事务内顺序执行,
 * rebuild 迁移单独执行。任何失败都会回滚并抛出 MigrationError(含备份路径)。
 */
export async function migrate(
    sqlite: Sqlite,
    migrations: readonly Migration[],
    options: MigrateOptions = {},
): Promise<MigrateResult> {
    validateList(migrations);
    ensureJournal(sqlite);
    const now = options.now ?? (() => new Date());

    const applied = appliedMigrations(sqlite);
    for (const [id, row] of applied) {
        const known = migrations[id - 1];
        if (!known) {
            throw new MigrationError(`database has migration ${id} (${row.name}) unknown to this version`, null);
        }
        if (checksum(known.sql) !== row.checksum) {
            throw new MigrationError(`migration ${id} (${row.name}) was modified after it was applied`, null);
        }
    }

    const pending = migrations.filter((m) => !applied.has(m.id));
    if (pending.length === 0) return { applied: [], backupPath: null };

    let backupPath: string | null = null;
    if (options.backupDir && !sqlite.memory && hasUserTables(sqlite)) {
        backupPath = await backup(sqlite, options.backupDir, pending[0]!.id, now(), options.keepBackups ?? 5);
    }

    const record = sqlite.prepare(`INSERT INTO ${JOURNAL_TABLE} (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)`);
    const done: number[] = [];

    // 连续的普通迁移合并到一个事务;rebuild 迁移单独处理
    let batch: Migration[] = [];
    const flush = () => {
        if (batch.length === 0) return;
        const current = batch;
        batch = [];
        sqlite.transaction(() => {
            for (const m of current) {
                sqlite.exec(m.sql);
                m.data?.(sqlite, { now });
                record.run(m.id, m.name, checksum(m.sql), now().toISOString());
            }
        })();
        done.push(...current.map((m) => m.id));
    };

    try {
        for (const m of pending) {
            if (!m.rebuild) {
                batch.push(m);
                continue;
            }
            flush();
            runRebuild(sqlite, m, () => record.run(m.id, m.name, checksum(m.sql), now().toISOString()));
            done.push(m.id);
        }
        flush();
    } catch (error) {
        const failed = pending.find((m) => !done.includes(m.id));
        throw new MigrationError(
            `migration ${failed?.id ?? '?'} (${failed?.name ?? '?'}) failed: ${(error as Error).message}`,
            backupPath,
            { cause: error },
        );
    }
    return { applied: done, backupPath };
}

function runRebuild(sqlite: Sqlite, m: Migration, recordFn: () => void): void {
    sqlite.pragma('foreign_keys = OFF');
    try {
        sqlite.transaction(() => {
            sqlite.exec(m.sql);
            const violations = sqlite.pragma('foreign_key_check') as unknown[];
            if (violations.length > 0) {
                throw new StorageError(`foreign_key_check reported ${violations.length} violation(s)`);
            }
            recordFn();
        })();
    } finally {
        sqlite.pragma('foreign_keys = ON');
        assertForeignKeysOn(sqlite);
    }
}

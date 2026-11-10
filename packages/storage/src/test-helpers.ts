// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 仅供本包测试使用(不从 index.ts 导出)。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Connection } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories, type Repositories } from './repos.js';

export interface TestDb {
    dir: string;
    path: string;
    conn: Connection;
    repos: Repositories;
    ownerId: string;
    cleanup(): void;
}

/** 在临时目录建一个已迁移的真实 SQLite 文件,并创建主人账户。 */
export async function createTestDb(options: { now?: () => Date } = {}): Promise<TestDb> {
    const dir = mkdtempSync(join(tmpdir(), 'aip-storage-'));
    const path = join(dir, 'db.sqlite');
    const conn = openDatabase(path);
    await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
    const repos = createRepositories(conn, options);
    const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    return {
        dir,
        path,
        conn,
        repos,
        ownerId,
        cleanup() {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 可手动推进的假时钟,保证时间戳严格递增。 */
export function fakeClock(start = '2026-11-03T00:00:00.000Z') {
    let ms = Date.parse(start);
    return {
        now: () => new Date(ms),
        tick: (delta = 1) => {
            ms += delta;
        },
        auto: () => () => new Date((ms += 1)),
    };
}

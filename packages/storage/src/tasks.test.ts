// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories } from './repos.js';

const seed = {
    key: 'k',
    name: 'K',
    trigger: { kind: 'cron', expression: '30 3 * * *' },
    action: { kind: 'system', key: 'k' },
    policy: { maxAttempts: 3, misfire: 'catchUp', quietHours: null, maxRuntimeMinutes: 30 },
} as const;

describe('migration 0016 与任务仓储', () => {
    it('在已有数据的库上只新增两张表,外键检查干净;系统任务幂等创建、不可删除;运行记录分页并按保留量清理', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m16-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 15),
                { backupDir: join(dir, 'backups') },
            );
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual(migrations.filter((m) => m.id >= 16).map((m) => m.id));
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);
            expect(conn.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');

            const { tasks } = createRepositories(conn);
            const a = tasks.ensureSystem('o', seed);
            expect(tasks.ensureSystem('o', { ...seed, name: 'changed' }).id).toBe(a.id); // 幂等,不覆盖用户改过的
            expect(tasks.list('o')).toHaveLength(1);
            expect(tasks.delete('o', a.id)).toBe(false); // 系统任务不可删
            const off = tasks.update('o', a.id, { enabled: false })!;
            expect(off.enabled).toBe(false);
            expect(tasks.listActive()).toHaveLength(0);

            for (let i = 0; i < 5; i++) {
                tasks.createRun({ taskId: a.id, trigger: 'manual', scheduledFor: new Date().toISOString() });
            }
            const first = tasks.listRuns(a.id, { limit: 2 });
            expect(first.items).toHaveLength(2);
            const second = tasks.listRuns(a.id, { limit: 2, cursor: first.nextCursor! });
            expect(second.items.map((r) => r.id)).not.toContain(first.items[0]!.id);
            expect(tasks.pruneRuns(a.id, 3)).toBe(2);
            expect(tasks.listRuns(a.id, { limit: 10 }).items).toHaveLength(3);
            expect(tasks.interruptUnfinished()).toBe(3);
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories } from './repos.js';

const seedTask = {
    key: 'k',
    name: 'K',
    trigger: { kind: 'cron', expression: '30 3 * * *' },
    action: { kind: 'system', key: 'k' },
    policy: { maxAttempts: 3, misfire: 'catchUp', quietHours: null, maxRuntimeMinutes: 30 },
} as const;

const newPlugin = {
    pluginId: 'acme.notes',
    version: '1.0.0',
    sourceKind: 'local',
    sourceRef: '/tmp/acme',
    contentSha256: 'a'.repeat(64),
    manifest: { id: 'acme.notes' },
    granted: { tools: [] },
} as const;

describe('migration 0018 与插件仓储', () => {
    it('带数据的旧库迁移前自动备份,迁移后原数据不变、外键干净;回退到备份可用旧迁移集正常打开', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m18-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 17),
                { backupDir: join(dir, 'backups') },
            );
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            conn.sqlite
                .prepare(
                    `INSERT INTO tasks (id, owner_id, name, kind, status, enabled, trigger_json, action_json, policy_json,
                       system_key, created_at, updated_at)
                     VALUES ('t1','o','K','system','active',1,'{"kind":"cron","expression":"30 3 * * *"}',
                       '{"kind":"system","key":"k"}','{"maxAttempts":3,"misfire":"catchUp","quietHours":null,"maxRuntimeMinutes":30}',
                       'k','t','t')`,
                )
                .run();

            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual([18, 19]);
            expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);
            expect(conn.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');

            const { tasks } = createRepositories(conn);
            expect(tasks.list('o').map((t) => t.id)).toEqual(['t1']);
            expect(tasks.list('o')[0]!.disabledReason).toBeNull();

            // 旧版本不能直接打开已迁移的库;文档不得再写成「能启动」
            await expect(
                migrate(
                    conn.sqlite,
                    migrations.filter((m) => m.id <= 17),
                ),
            ).rejects.toThrow('database has migration 18 (plugins) unknown to this version');

            // 备份是迁移前的库:没有新表,仍能按旧迁移集打开
            const old = openDatabase(result.backupPath!);
            try {
                expect(
                    (
                        await migrate(
                            old.sqlite,
                            migrations.filter((m) => m.id <= 17),
                        )
                    ).applied,
                ).toEqual([]);
                const names = (
                    old.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
                        name: string;
                    }[]
                ).map((r) => r.name);
                expect(names).not.toContain('plugins');
            } finally {
                old.close();
            }
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('插件增删改、唯一约束、状态 CHECK;事件分页与保留期清理;卸载后事件保留', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-plugins-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        let tick = 0;
        try {
            await migrate(conn.sqlite, migrations);
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            const { plugins } = createRepositories(conn, { now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)) });

            const p = plugins.create('o', { ...newPlugin, secretRefs: { KEY: 'env:ACME_KEY' } });
            expect(p.state).toBe('disabled');
            expect(p.secretRefs).toEqual({ KEY: 'env:ACME_KEY' });
            expect(() => plugins.create('o', newPlugin)).toThrow(/UNIQUE/);

            const up = plugins.update('o', 'acme.notes', {
                version: '1.1.0',
                previousVersion: '1.0.0',
                state: 'enabled',
            })!;
            expect([up.version, up.previousVersion, up.state, up.sourceRef]).toEqual([
                '1.1.0',
                '1.0.0',
                'enabled',
                '/tmp/acme',
            ]);
            expect(plugins.update('o', 'nope', { state: 'error' })).toBeNull();
            expect(() => plugins.update('o', 'acme.notes', { state: 'bogus' as never })).toThrow(/CHECK/);

            for (let i = 0; i < 5; i++) {
                plugins.addEvent('o', { pluginId: 'acme.notes', kind: 'denied', detail: `m${i}` });
            }
            plugins.addEvent('o', { pluginId: 'other', kind: 'installed' });
            const first = plugins.listEvents('o', { pluginId: 'acme.notes', limit: 2 });
            expect(first.items.map((e) => e.detail)).toEqual(['m4', 'm3']);
            const second = plugins.listEvents('o', { pluginId: 'acme.notes', limit: 10, cursor: first.nextCursor! });
            expect(second.items.map((e) => e.detail)).toEqual(['m2', 'm1', 'm0']);
            expect(second.nextCursor).toBeNull();

            expect(plugins.delete('o', 'acme.notes')).toBe(true);
            expect(plugins.list('o')).toEqual([]);
            expect(plugins.listEvents('o', { limit: 50 }).items).toHaveLength(6); // 事件不随插件删除

            const cutoff = plugins.listEvents('o', { limit: 50 }).items[2]!.at;
            expect(plugins.purgeEvents(cutoff)).toBe(3);
            expect(plugins.listEvents('o', { limit: 50 }).items).toHaveLength(3);
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('任务 disabledReason:系统写入停用原因,重新启用时清空', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-dr-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(conn.sqlite, migrations);
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            const { tasks } = createRepositories(conn);
            const t = tasks.ensureSystem('o', seedTask);
            const off = tasks.update('o', t.id, { enabled: false, disabledReason: 'plugin_removed' })!;
            expect([off.enabled, off.disabledReason]).toEqual([false, 'plugin_removed']);
            expect(tasks.update('o', t.id, { name: 'renamed' })!.disabledReason).toBe('plugin_removed');
            const on = tasks.update('o', t.id, { enabled: true })!;
            expect([on.enabled, on.disabledReason]).toEqual([true, null]);
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

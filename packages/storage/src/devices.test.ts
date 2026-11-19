// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { MAX_OPEN_PAIRING_CODES, type DeviceTokenHashes } from './devices.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
const clock = fakeClock();

beforeEach(async () => {
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const minutes = (n: number) => new Date(clock.now().getTime() + n * 60_000);
const tokens = (tag: string): DeviceTokenHashes => ({
    accessHash: `access-${tag}`,
    accessExpiresAt: minutes(15),
    refreshHash: `refresh-${tag}`,
    refreshExpiresAt: minutes(60 * 24),
});

describe('配对码', () => {
    it('只能用一次,过期的码不能用,同时有效的码有上限', () => {
        const { devices } = t.repos;
        expect(devices.createPairingCode(t.ownerId, 'code-1', minutes(5))).toBe(true);
        expect(devices.pair('code-1', 'phone', tokens('a'))?.device.name).toBe('phone');
        expect(devices.pair('code-1', 'again', tokens('b'))).toBeNull();

        devices.createPairingCode(t.ownerId, 'code-old', minutes(5));
        clock.tick(6 * 60_000);
        expect(devices.pair('code-old', 'late', tokens('c'))).toBeNull();

        for (let i = 0; i < MAX_OPEN_PAIRING_CODES; i++) {
            expect(devices.createPairingCode(t.ownerId, `open-${i}`, minutes(5))).toBe(true);
        }
        expect(devices.createPairingCode(t.ownerId, 'one-too-many', minutes(5))).toBe(false);
    });
});

describe('设备令牌', () => {
    function pairDevice() {
        t.repos.devices.createPairingCode(t.ownerId, 'code', minutes(5));
        const paired = t.repos.devices.pair('code', 'phone', tokens('0'));
        if (!paired) throw new Error('pairing failed');
        return paired.device;
    }

    it('refresh 每次轮换:旧 access 立即失效,新令牌可用', () => {
        const { devices } = t.repos;
        const device = pairDevice();
        expect(devices.findByAccess('access-0')?.deviceId).toBe(device.id);
        expect(devices.rotate('refresh-0', tokens('1')).status).toBe('ok');
        expect(devices.findByAccess('access-0')).toBeNull();
        expect(devices.findByAccess('access-1')?.deviceId).toBe(device.id);
    });

    it('重放已用过的 refresh 会吊销整台设备,包括刚发的新令牌', () => {
        const { devices } = t.repos;
        const device = pairDevice();
        devices.rotate('refresh-0', tokens('1'));
        expect(devices.rotate('refresh-0', tokens('2'))).toMatchObject({ status: 'replay', deviceId: device.id });
        expect(devices.findByAccess('access-1')).toBeNull();
        expect(devices.rotate('refresh-1', tokens('3')).status).toBe('invalid');
        expect(devices.list(t.ownerId)).toEqual([]);
    });

    it('吊销立即生效;过期的 refresh 无效', () => {
        const { devices } = t.repos;
        const device = pairDevice();
        expect(devices.revoke(t.ownerId, device.id, 'owner')).toBe(true);
        expect(devices.findByAccess('access-0')).toBeNull();
        expect(devices.rotate('refresh-0', tokens('1')).status).toBe('invalid');
    });
});

describe('migration 0020', () => {
    it('在已有数据的库上只新增四张表,备份在前,外键检查干净', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m20-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 19),
                { backupDir: join(dir, 'backups') },
            );
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            const tables = () =>
                (conn.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
                    .map((r) => r.name)
                    .sort();
            const before = tables();

            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual([20]);
            expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
            expect(tables().filter((n) => !before.includes(n))).toEqual([
                'device_events',
                'device_tokens',
                'devices',
                'pairing_codes',
            ]);
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);
            expect(conn.sqlite.prepare('SELECT count(*) AS n FROM owners').get()).toEqual({ n: 1 });
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

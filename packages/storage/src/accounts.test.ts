// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理仓储(ADR 0053 第 2 节):邀请码、重置码、改角色、停用、删除,以及停用账户的凭据全部失效。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_OPEN_ACCOUNT_CODES } from './accounts.js';
import { backupDatabase } from './migrate.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
    clock = fakeClock('2026-11-25T00:00:00.000Z');
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const later = (ms: number) => new Date(clock.now().getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;
const invite = (hash: string, expiresAt = later(DAY)) =>
    t.repos.accounts.createCode({ adminId: t.ownerId, kind: 'invite', targetOwnerId: null, codeHash: hash, expiresAt });
const join = (hash: string, username: string) =>
    t.repos.accounts.acceptInvite(hash, { username, passwordHash: 'p', displayName: null });

/** 给账户造一套凭据:登录会话、个人访问令牌、设备与设备令牌。 */
function credentials(ownerId: string, tag: string) {
    const { repos } = t;
    repos.authSessions.create({ idHash: `s-${tag}`, ownerId, csrfHash: 'c', expiresAt: later(DAY) });
    repos.accessTokens.create({ ownerId, name: tag, tokenHash: `t-${tag}`, expiresAt: null });
    expect(repos.devices.createPairingCode(ownerId, `pc-${tag}`, later(DAY))).toBe(true);
    const paired = repos.devices.pair(`pc-${tag}`, tag, {
        accessHash: `a-${tag}`,
        accessExpiresAt: later(DAY),
        refreshHash: `r-${tag}`,
        refreshExpiresAt: later(DAY),
    });
    expect(paired).not.toBeNull();
    return {
        session: () => repos.authSessions.getValid(`s-${tag}`),
        token: () => repos.accessTokens.findUsable(`t-${tag}`),
        device: () => repos.devices.findByAccess(`a-${tag}`),
    };
}

describe('accounts', () => {
    it('邀请码:建成员、只能用一次;过期、未知、用户名被占用(不消耗码)都不行', () => {
        expect(invite('h1')).toBe(true);
        expect(join('h1', 'owner')).toEqual({ status: 'username_taken' });
        const ok = join('h1', 'kid');
        expect(ok).toMatchObject({ status: 'ok', owner: { username: 'kid', role: 'member' } });
        expect(join('h1', 'kid2')).toEqual({ status: 'invalid' });
        expect(join('unknown', 'kid3')).toEqual({ status: 'invalid' });
        expect(invite('h2', later(1000))).toBe(true);
        clock.tick(1001);
        expect(join('h2', 'kid4')).toEqual({ status: 'invalid' });
        expect(t.repos.accounts.list().map((a) => [a.username, a.role])).toEqual([
            ['owner', 'admin'],
            ['kid', 'member'],
        ]);
    });

    it('未用的码有上限;生成它的管理员被停用后码作废', () => {
        for (let i = 0; i < MAX_OPEN_ACCOUNT_CODES; i++) expect(invite(`c${i}`)).toBe(true);
        expect(invite('too-many')).toBe(false);

        const second = t.repos.owners.create({ username: 'admin2', passwordHash: 'x', role: 'admin' }).id;
        expect(t.repos.accounts.setDisabled(t.ownerId, true)).toBe('ok');
        expect(join('c0', 'kid')).toEqual({ status: 'invalid' });
        expect(t.repos.accounts.setDisabled(t.ownerId, false)).toBe('ok');
        expect(join('c0', 'kid')).toMatchObject({ status: 'ok' });
        expect(second).toBeTruthy();
    });

    it('重置码:设新密码,作废该账户的会话、令牌和设备,别人的不动', () => {
        invite('i');
        const kid = join('i', 'kid');
        if (kid.status !== 'ok') throw new Error('invite failed');
        const kidCreds = credentials(kid.owner.id, 'kid');
        const ownerCreds = credentials(t.ownerId, 'owner');
        expect(
            t.repos.accounts.createCode({
                adminId: t.ownerId,
                kind: 'reset',
                targetOwnerId: kid.owner.id,
                codeHash: 'r1',
                expiresAt: later(DAY),
            }),
        ).toBe(true);
        expect(t.repos.accounts.resetPassword('i', 'new')).toBeNull(); // 邀请码不能当重置码用
        expect(t.repos.accounts.resetPassword('r1', 'new')).toEqual({ ownerId: kid.owner.id });
        expect(t.repos.owners.get(kid.owner.id)?.passwordHash).toBe('new');
        expect([kidCreds.session(), kidCreds.token(), kidCreds.device()]).toEqual([null, null, null]);
        expect(ownerCreds.session()).not.toBeNull();
        expect(ownerCreds.token()).not.toBeNull();
        expect(ownerCreds.device()).not.toBeNull();
        expect(t.repos.accounts.resetPassword('r1', 'again')).toBeNull();
    });

    it('停用:凭据立即失效(会话、令牌、设备 access 与 refresh、配对码);启用后旧凭据也不恢复', () => {
        invite('i');
        const kid = join('i', 'kid');
        if (kid.status !== 'ok') throw new Error('invite failed');
        const creds = credentials(kid.owner.id, 'kid');
        expect(t.repos.devices.createPairingCode(kid.owner.id, 'pc-open', later(DAY))).toBe(true);
        expect(t.repos.accounts.setDisabled(kid.owner.id, true)).toBe('ok');
        expect(t.repos.accounts.get(kid.owner.id)?.disabledAt).not.toBeNull();
        expect([creds.session(), creds.token(), creds.device()]).toEqual([null, null, null]);
        const hashes = {
            accessHash: 'a2',
            accessExpiresAt: later(DAY),
            refreshHash: 'r2',
            refreshExpiresAt: later(DAY),
        };
        expect(t.repos.devices.rotate('r-kid', hashes).status).toBe('invalid');
        expect(t.repos.devices.pair('pc-open', 'x', hashes)).toBeNull();
        expect(t.repos.accounts.setDisabled(kid.owner.id, false)).toBe('ok');
        expect([creds.session(), creds.token(), creds.device()]).toEqual([null, null, null]);
    });

    it('即使不经 setDisabled 直接改库,停用账户的会话、令牌和设备也查不到', () => {
        invite('i');
        const kid = join('i', 'kid');
        if (kid.status !== 'ok') throw new Error('invite failed');
        const creds = credentials(kid.owner.id, 'kid');
        t.conn.sqlite.prepare("UPDATE owners SET disabled_at = 't' WHERE id = ?").run(kid.owner.id);
        expect([creds.session(), creds.token(), creds.device()]).toEqual([null, null, null]);
    });

    it('最后一个管理员不能降级、停用、删除;改角色与删除;删除级联删掉账户的数据', async () => {
        expect(t.repos.accounts.setRole(t.ownerId, 'member')).toBe('last_admin');
        expect(t.repos.accounts.setDisabled(t.ownerId, true)).toBe('last_admin');
        expect(t.repos.accounts.remove(t.ownerId)).toBe('last_admin');
        expect(t.repos.accounts.setRole('missing', 'admin')).toBe('not_found');
        expect(t.repos.accounts.remove('missing')).toBe('not_found');

        invite('i');
        const kid = join('i', 'kid');
        if (kid.status !== 'ok') throw new Error('invite failed');
        expect(t.repos.accounts.setRole(kid.owner.id, 'admin')).toBe('ok');
        expect(t.repos.accounts.setRole(t.ownerId, 'member')).toBe('ok');
        expect(t.repos.accounts.setRole(t.ownerId, 'admin')).toBe('ok');
        expect(t.repos.accounts.setDisplayName(kid.owner.id, '小明')).toBe(true);
        expect(t.repos.accounts.get(kid.owner.id)).toMatchObject({ role: 'admin', displayName: '小明' });

        const session = t.repos.sessions.create(kid.owner.id, { title: 'mine' });
        credentials(kid.owner.id, 'kid');
        const backup = await backupDatabase(t.conn.sqlite, `${t.dir}/backups`, 'delete-account', clock.now());
        expect(backup).toMatch(/db-.*-pre-delete-account\.sqlite$/);
        expect(t.repos.accounts.remove(kid.owner.id)).toBe('ok');
        expect(t.repos.sessions.get(kid.owner.id, session.id)).toBeNull();
        const leftovers = (table: string) =>
            (
                t.conn.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id = ?`).get(kid.owner.id) as {
                    n: number;
                }
            ).n;
        for (const table of ['sessions', 'auth_sessions', 'access_tokens', 'devices', 'pairing_codes']) {
            expect(leftovers(table)).toBe(0);
        }
        expect(t.conn.sqlite.pragma('foreign_key_check')).toEqual([]);
        expect(t.repos.accounts.list().map((a) => a.username)).toEqual(['owner']);
    });

    it('停用账户的任务、渠道不再被后台启动;启用后恢复', () => {
        invite('i');
        const kid = join('i', 'kid');
        if (kid.status !== 'ok') throw new Error('invite failed');
        const seed = {
            key: 'k',
            name: 'K',
            trigger: { kind: 'cron', expression: '30 3 * * *' },
            action: { kind: 'system', key: 'k' },
            policy: { maxAttempts: 3, misfire: 'catchUp', quietHours: null, maxRuntimeMinutes: 30 },
        } as const;
        t.repos.tasks.ensureSystem(kid.owner.id, seed);
        t.repos.tasks.ensureSystem(t.ownerId, seed);
        const channel = t.repos.channels.create(kid.owner.id, { kind: 'wechat', label: 'W' });
        t.repos.channels.update(kid.owner.id, channel.id, { enabled: true });
        const owners = () => ({
            tasks: t.repos.tasks
                .listActive()
                .map((x) => x.ownerId)
                .sort(),
            channels: t.repos.channels.allEnabled().map((x) => x.ownerId),
        });
        expect(owners()).toEqual({ tasks: [t.ownerId, kid.owner.id].sort(), channels: [kid.owner.id] });
        t.repos.accounts.setDisabled(kid.owner.id, true);
        expect(owners()).toEqual({ tasks: [t.ownerId], channels: [] });
        t.repos.accounts.setDisabled(kid.owner.id, false);
        expect(owners()).toEqual({ tasks: [t.ownerId, kid.owner.id].sort(), channels: [kid.owner.id] });
    });
});

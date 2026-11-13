// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ADR 0027 测试清单:登录两步、重放、恢复码、限流、越权、主密钥不可用、回归。只用临时数据目录与假密钥。
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoginChallenge, LoginResponse, TotpRecoveryCodes, TotpSetup, TotpStatus } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from './auth/crypto.js';
import { LoginChallenges } from './auth/login-challenge.js';
import { FailureLimiter } from './auth/rate-limit.js';
import { base32Decode, hotp, timeStep } from './auth/totp.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
let clock = T0;
const now = () => new Date(clock);
const codeAt = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), timeStep(clock) + offsetSteps);

let s: TestServer;
afterEach(() => s?.cleanup());

interface Opts {
    limiter?: FailureLimiter;
}

async function boot(opts: Opts = {}) {
    clock = T0;
    const challenges = new LoginChallenges(now);
    s = await createTestServer(
        {},
        { authNow: now, challenges, totpLimiter: opts.limiter ?? new FailureLimiter(100, 60_000) },
    );
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const session = sessionFrom(res);
    const call = (
        who: { cookie: string; csrf: string },
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
    ) =>
        s.app.request(`/api/v1${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json', ...extra },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const login = (extra: Record<string, string> = {}) =>
        s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password: TEST_PASSWORD }, extra));
    const loginTotp = (body: unknown, extra: Record<string, string> = {}) =>
        s.app.request('/api/v1/auth/login/totp', jsonBody(body, extra));
    const challenge = async (extra: Record<string, string> = {}) =>
        LoginChallenge.parse(await (await login(extra)).json()).challengeToken;

    /** setup + enable,返回共享密钥与恢复码。 */
    async function enable(who = session) {
        const setup = await call(who, '/auth/totp/setup', { password: TEST_PASSWORD });
        expect(setup.status).toBe(200);
        const { secret } = TotpSetup.parse(await setup.json());
        const on = await call(who, '/auth/totp/enable', { password: TEST_PASSWORD, code: codeAt(secret) });
        expect(on.status).toBe(200);
        const { recoveryCodes } = TotpRecoveryCodes.parse(await on.json());
        return { secret, recoveryCodes };
    }
    const ownerId = () => s.repos.owners.ids()[0]!;
    return { session, call, login, loginTotp, challenge, enable, ownerId };
}

describe('regression: accounts without TOTP', () => {
    it('login still answers 200 with a session cookie and the same body shape', async () => {
        const t = await boot();
        const res = await t.login();
        expect(res.status).toBe(200);
        expect(LoginResponse.safeParse(await res.json()).success).toBe(true);
        expect(sessionFrom(res).cookie).toContain('aip_session=');
        const status = TotpStatus.parse(await (await t.call(t.session, '/auth/totp')).json());
        expect(status).toEqual({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
    });
});

describe('sign-in with a second factor', () => {
    it('enable revokes other sessions; login then needs the code and sets second_factor_at', async () => {
        const t = await boot();
        const other = sessionFrom(await t.login());
        const { secret } = await t.enable();
        expect((await t.call(other, '/auth/me')).status).toBe(401); // 其他会话被撤销
        expect((await t.call(t.session, '/auth/me')).status).toBe(200); // 当前会话保留
        const status = TotpStatus.parse(await (await t.call(t.session, '/auth/totp')).json());
        expect(status).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });

        const first = await t.login();
        expect(first.status).toBe(202);
        expect(first.headers.get('cache-control')).toBe('no-store');
        expect(first.headers.getSetCookie()).toEqual([]);
        const token = LoginChallenge.parse(await first.json()).challengeToken;

        expect((await t.loginTotp({ challengeToken: token, code: '000000' })).status).toBe(401);
        clock += 30_000; // 下一个步长,避开启用时用掉的那个
        const done = await t.loginTotp({ challengeToken: token, code: codeAt(secret) });
        expect(done.status).toBe(200);
        expect(done.headers.get('cache-control')).toBe('no-store');
        const session = sessionFrom(done);
        expect(session.cookie).toContain('aip_session=');
        const row = s.repos.authSessions.getValid(sha256(/aip_session=([^;]+)/.exec(session.cookie)![1]!));
        expect(row?.secondFactorAt).not.toBeNull();
        expect((await t.call(session, '/auth/me')).status).toBe(200);
    });

    it('a wrong password and a wrong code are the same kind of error', async () => {
        const t = await boot();
        await t.enable();
        const badPassword = await s.app.request(
            '/api/v1/auth/login',
            jsonBody({ username: 'owner', password: 'not the right password' }),
        );
        const token = await t.challenge();
        const badCode = await t.loginTotp({ challengeToken: token, code: '123456' });
        expect(badPassword.status).toBe(401);
        expect(badCode.status).toBe(401);
        const [a, b] = (await Promise.all([badPassword.json(), badCode.json()])) as { code: string }[];
        expect(a!.code).toBe(b!.code);
    });

    it('accepts one step either side and refuses two', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        clock += 90_000;
        for (const [offset, status] of [
            [-1, 200],
            [1, 200],
            [-2, 401],
            [2, 401],
        ] as const) {
            clock += 90_000; // 每次换一个远离已用步长的时间
            const res = await t.loginTotp({ challengeToken: await t.challenge(), code: codeAt(secret, offset) });
            expect(res.status, `offset ${offset}`).toBe(status);
        }
    });

    it('a code works once per time step; two concurrent submissions of one code let only one through', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        clock += 60_000;
        const code = codeAt(secret);
        const a = await t.challenge();
        const b = await t.challenge();
        const results = await Promise.all([
            t.loginTotp({ challengeToken: a, code }),
            t.loginTotp({ challengeToken: b, code }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
        // 同一个步长之后再用同一个验证码也不行,下一个步长的可以
        expect((await t.loginTotp({ challengeToken: await t.challenge(), code })).status).toBe(401);
        expect((await t.loginTotp({ challengeToken: await t.challenge(), code: codeAt(secret, 1) })).status).toBe(200);
    });
});

describe('recovery codes', () => {
    it('work once, can be regenerated (old ones die), and the database never holds them in plaintext', async () => {
        const t = await boot();
        const { secret, recoveryCodes } = await t.enable();
        expect(new Set(recoveryCodes).size).toBe(10);

        const first = await t.loginTotp({
            challengeToken: await t.challenge(),
            recoveryCode: recoveryCodes[0]!.toLowerCase(),
        });
        expect(first.status).toBe(200);
        expect(
            (await t.loginTotp({ challengeToken: await t.challenge(), recoveryCode: recoveryCodes[0]! })).status,
        ).toBe(401);
        const who = sessionFrom(first);
        expect(TotpStatus.parse(await (await t.call(who, '/auth/totp')).json()).recoveryCodesRemaining).toBe(9);

        clock += 60_000;
        const regen = await t.call(who, '/auth/totp/recovery-codes', { password: TEST_PASSWORD, code: codeAt(secret) });
        expect(regen.status).toBe(200);
        const fresh = TotpRecoveryCodes.parse(await regen.json()).recoveryCodes;
        expect(
            (await t.loginTotp({ challengeToken: await t.challenge(), recoveryCode: recoveryCodes[1]! })).status,
        ).toBe(401); // 旧码作废
        expect((await t.loginTotp({ challengeToken: await t.challenge(), recoveryCode: fresh[0]! })).status).toBe(200);

        const rows = JSON.stringify(s.conn.sqlite.prepare('SELECT * FROM totp_recovery_codes').all());
        for (const code of [...recoveryCodes, ...fresh]) expect(rows).not.toContain(code);
        expect(rows).not.toContain(secret);
        const everything = s.conn.sqlite.prepare('SELECT * FROM totp_credentials').all();
        expect(JSON.stringify(everything)).not.toContain(secret);
        expect(s.logs.join('\n')).not.toContain(secret);
        for (const code of fresh) expect(s.logs.join('\n')).not.toContain(code);
    });
});

describe('rate limit (per user name and per IP)', () => {
    it('locks an IP on its own, even for a correct code, while another IP is still fine', async () => {
        const t = await boot({ limiter: new FailureLimiter(5, 60_000) });
        const { secret } = await t.enable();
        clock += 60_000;
        const ip = { 'x-test-ip': '203.0.113.7' };
        for (let i = 0; i < 5; i++) {
            expect((await t.loginTotp({ challengeToken: 'x'.repeat(43), code: '111111' }, ip)).status).toBe(401);
        }
        // 这个 IP 被锁:正确的验证码也拒绝
        const locked = await t.loginTotp({ challengeToken: await t.challenge(), code: codeAt(secret) }, ip);
        expect(locked.status).toBe(429);
        expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
        // 另一个 IP:未被锁
        const other = await t.loginTotp(
            { challengeToken: await t.challenge({ 'x-test-ip': '198.51.100.9' }), code: codeAt(secret) },
            { 'x-test-ip': '198.51.100.9' },
        );
        expect(other.status).toBe(200);
    });

    it('locks the user name across different IPs, even for a correct code', async () => {
        const t = await boot({ limiter: new FailureLimiter(5, 60_000) });
        const { secret } = await t.enable();
        clock += 60_000;
        for (let i = 0; i < 5; i++) {
            const ip = { 'x-test-ip': `192.0.2.${i + 1}` };
            const res = await t.loginTotp({ challengeToken: await t.challenge(ip), code: '222222' }, ip);
            expect(res.status).toBe(401);
        }
        const ip = { 'x-test-ip': '192.0.2.99' };
        const res = await t.loginTotp({ challengeToken: await t.challenge(ip), code: codeAt(secret) }, ip);
        expect(res.status).toBe(429);
    });

    it('a challenge dies after 5 wrong codes and must be re-issued with the password', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        clock += 60_000;
        const token = await t.challenge();
        for (let i = 0; i < 5; i++) {
            expect((await t.loginTotp({ challengeToken: token, code: '333333' })).status).toBe(401);
        }
        expect((await t.loginTotp({ challengeToken: token, code: codeAt(secret) })).status).toBe(401);
    });

    it('enable / disable / recovery-codes also lock after repeated failures', async () => {
        const t = await boot({ limiter: new FailureLimiter(5, 60_000) });
        await t.enable();
        for (let i = 0; i < 5; i++) {
            expect(
                (await t.call(t.session, '/auth/totp/disable', { password: 'wrong password!!', code: '111111' }))
                    .status,
            ).toBe(403);
        }
        const res = await t.call(t.session, '/auth/totp/disable', { password: TEST_PASSWORD, code: '111111' });
        expect(res.status).toBe(429);
    });
});

describe('access control', () => {
    it('a challenge token is not a session, a CSRF token or a way to create access tokens', async () => {
        const t = await boot();
        await t.enable();
        const token = await t.challenge();
        const asCookie = await s.app.request('/api/v1/auth/me', { headers: { cookie: `aip_session=${token}` } });
        expect(asCookie.status).toBe(401);
        const asBearer = await s.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } });
        expect(asBearer.status).toBe(401);
        // 用作 CSRF:拿真实会话的 Cookie 加上临时凭证当 X-CSRF-Token
        const asCsrf = await t.call({ cookie: t.session.cookie, csrf: token }, '/tokens', { name: 'x' });
        expect(asCsrf.status).toBe(403);
        const create = await s.app.request('/api/v1/tokens', jsonBody({ name: 'x' }, { 'X-CSRF-Token': token }));
        expect(create.status).toBe(401);
        expect(s.repos.accessTokens.list(t.ownerId())).toEqual([]);
    });

    it('expired and already-used challenges are refused', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        clock += 60_000;
        const stale = await t.challenge();
        clock += 5 * 60_000 + 1;
        expect((await t.loginTotp({ challengeToken: stale, code: codeAt(secret) })).status).toBe(401);
        const used = await t.challenge();
        expect((await t.loginTotp({ challengeToken: used, code: codeAt(secret) })).status).toBe(200);
        clock += 30_000;
        expect((await t.loginTotp({ challengeToken: used, code: codeAt(secret) })).status).toBe(401);
    });

    it('with TOTP on, only a session that passed the second factor can create access tokens', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        // 一个没通过第二因素的会话(直接写库模拟旧会话)
        const loose = { cookie: 'aip_session=loose-session-token', csrf: 'loose-csrf' };
        s.repos.authSessions.create({
            idHash: sha256('loose-session-token'),
            ownerId: t.ownerId(),
            csrfHash: sha256('loose-csrf'),
            expiresAt: new Date(clock + 60_000_000),
        });
        expect((await t.call(loose, '/tokens', { name: 'nope' })).status).toBe(403);
        expect((await t.call(t.session, '/tokens', { name: 'ok' })).status).toBe(201);
        clock += 60_000;
        const via = sessionFrom(await t.loginTotp({ challengeToken: await t.challenge(), code: codeAt(secret) }));
        expect((await t.call(via, '/tokens', { name: 'ok2' })).status).toBe(201);
    });

    it('enable, disable and recovery-codes refuse a missing or wrong password / second factor and change nothing', async () => {
        const t = await boot();
        const setup = await t.call(t.session, '/auth/totp/setup', { password: TEST_PASSWORD });
        const { secret } = TotpSetup.parse(await setup.json());
        const code = codeAt(secret);
        for (const body of [{ code }, { password: TEST_PASSWORD }, { password: 'wrong wrong wrong', code }, {}]) {
            expect(
                (await t.call(t.session, '/auth/totp/enable', body)).status,
                JSON.stringify(body),
            ).toBeGreaterThanOrEqual(400);
        }
        expect(TotpStatus.parse(await (await t.call(t.session, '/auth/totp')).json()).enabled).toBe(false);

        await t.call(t.session, '/auth/totp/enable', { password: TEST_PASSWORD, code });
        clock += 60_000;
        const next = codeAt(secret);
        for (const path of ['/auth/totp/disable', '/auth/totp/recovery-codes']) {
            for (const body of [
                { code: next },
                { password: TEST_PASSWORD },
                { password: 'wrong wrong wrong', code: next },
                { password: TEST_PASSWORD, code: '000000' },
                { password: TEST_PASSWORD, recoveryCode: 'AAAAA-AAAAA' },
            ]) {
                expect(
                    (await t.call(t.session, path, body)).status,
                    `${path} ${JSON.stringify(body)}`,
                ).toBeGreaterThanOrEqual(400);
            }
        }
        expect(TotpStatus.parse(await (await t.call(t.session, '/auth/totp')).json())).toMatchObject({
            enabled: true,
            recoveryCodesRemaining: 10,
        });
        const off = await t.call(t.session, '/auth/totp/disable', { password: TEST_PASSWORD, code: next });
        expect(off.status).toBe(204);
        expect((await t.login()).status).toBe(200);
    });

    it('personal access tokens keep working elsewhere but cannot use /auth/totp/* or create tokens once TOTP is on', async () => {
        const t = await boot();
        const created = await t.call(t.session, '/tokens', { name: 'cli' });
        const pat = ((await created.json()) as { token: string }).token;
        const bearer = { authorization: `Bearer ${pat}`, 'content-type': 'application/json' };
        await t.enable();
        expect((await s.app.request('/api/v1/auth/me', { headers: bearer })).status).toBe(200); // 已有令牌不受影响
        expect((await s.app.request('/api/v1/auth/totp', { headers: bearer })).status).toBe(403);
        for (const [path, body] of [
            ['/auth/totp/setup', { password: TEST_PASSWORD }],
            ['/auth/totp/enable', { password: TEST_PASSWORD, code: '123456' }],
            ['/auth/totp/disable', { password: TEST_PASSWORD, code: '123456' }],
            ['/auth/totp/recovery-codes', { password: TEST_PASSWORD, code: '123456' }],
        ] as const) {
            const res = await s.app.request(`/api/v1${path}`, {
                method: 'POST',
                headers: bearer,
                body: JSON.stringify(body),
            });
            expect(res.status, path).toBe(403);
        }
        const res = await s.app.request('/api/v1/tokens', {
            method: 'POST',
            headers: bearer,
            body: JSON.stringify({ name: 'more' }),
        });
        expect(res.status).toBe(403);
    });

    it('needs a login for every /auth/totp endpoint', async () => {
        const t = await boot();
        void t;
        expect((await s.app.request('/api/v1/auth/totp')).status).toBe(401);
        for (const path of ['setup', 'enable', 'disable', 'recovery-codes']) {
            expect(
                (await s.app.request(`/api/v1/auth/totp/${path}`, jsonBody({ password: TEST_PASSWORD }))).status,
            ).toBe(401);
        }
    });
});

describe('master key unavailable', () => {
    it('verification fails with 503 and no session instead of letting the user in', async () => {
        const t = await boot();
        const { secret } = await t.enable();
        clock += 60_000;
        const token = await t.challenge();
        const original = readFileSync(join(s.dir, 'master.key'), 'utf8');
        // 换成另一把密钥:共享密钥解不开
        writeFileSync(join(s.dir, 'master.key'), `${'ab'.repeat(32)}\n`);
        const res = await t.loginTotp({ challengeToken: token, code: codeAt(secret) });
        expect(res.status).toBe(503);
        expect(res.headers.getSetCookie()).toEqual([]);
        // 删掉密钥文件:同样不放行
        rmSync(join(s.dir, 'master.key'));
        expect((await t.loginTotp({ challengeToken: token, code: codeAt(secret) })).status).toBe(503);
        expect(
            (await t.call(t.session, '/auth/totp/disable', { password: TEST_PASSWORD, code: codeAt(secret) })).status,
        ).toBe(503);
        // 原来那把密钥回来后又能验证
        writeFileSync(join(s.dir, 'master.key'), original);
        expect((await t.loginTotp({ challengeToken: token, code: codeAt(secret) })).status).toBe(200);
    });

    it('setup and enable report the key as unavailable when the key file is unusable', async () => {
        const t = await boot();
        writeFileSync(join(s.dir, 'master.key'), 'not a key\n');
        const res = await t.call(t.session, '/auth/totp/setup', { password: TEST_PASSWORD });
        expect(res.status).toBe(503);
        expect(TotpStatus.parse(await (await t.call(t.session, '/auth/totp')).json()).enabled).toBe(false);
    });
});

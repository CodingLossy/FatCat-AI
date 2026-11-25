// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// QQ 官方机器人凭据(ADR 0052 第 4 节):假的 QQ 开放平台上走完「保存凭据 → AppSecret 写进 secrets.yaml →
// 渠道用它换令牌、连网关 → 收发单聊消息 → 删除渠道删掉 AppSecret」;API、日志与状态里都不出现 AppSecret 和令牌。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeQqPlatform } from '@fatcat-ai/channels/testing';
import { Channel, ChannelStatus } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const APP_ID = '102030';
const APP_SECRET = 'app-secret-value';

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('QQ bot credentials', () => {
    let platform: FakeQqPlatform;
    let s: TestServer;
    let req: (path: string, init?: RequestInit) => Promise<Response>;
    const secretsFile = () => join(s.dir, 'secrets.yaml');

    beforeEach(async () => {
        platform = new FakeQqPlatform({ appId: APP_ID, appSecret: APP_SECRET });
        await platform.listen();
        s = await createTestServer(
            {},
            { qqPlatform: { apiBaseUrl: platform.apiBaseUrl, tokenUrl: platform.tokenUrl } },
        );
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
        req = async (path, init = {}) => s.app.request(path, { headers, ...init });
    });
    afterEach(async () => {
        await s.cleanup();
        await platform.close();
    });

    const createChannel = async (kind: 'qq' | 'wechat' = 'qq') => {
        const res = await req('/api/v1/channels', { method: 'POST', body: JSON.stringify({ kind, label: 'QQ' }) });
        expect(res.status).toBe(201);
        const channel = Channel.parse(await res.json());
        await req(`/api/v1/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
        return channel;
    };
    const status = async (id: string) => ChannelStatus.parse(await (await req(`/api/v1/channels/${id}/status`)).json());
    const save = (id: string, body: unknown) =>
        req(`/api/v1/channels/${id}/qq/credentials`, { method: 'PUT', body: JSON.stringify(body) });

    it('saves the AppSecret to secrets.yaml, connects with it, answers in a direct chat, and removes it on delete', async () => {
        const original = '# keys\nDEEPSEEK_API_KEY: sk-test-0000\n';
        writeFileSync(secretsFile(), original, { mode: 0o600 });
        const channel = await createChannel();
        expect(channel.qq).toEqual({ appId: null });
        await until(async () => (await status(channel.id)).state === 'needs-login');

        const res = await save(channel.id, { appId: APP_ID, appSecret: APP_SECRET });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        const file = readFileSync(secretsFile(), 'utf8');
        expect(file.startsWith(original)).toBe(true);
        expect(file).toContain(`QQBOT_SECRET_${channel.id}: '${APP_SECRET}'`);
        const backups = readdirSync(join(s.dir, 'backups')).filter((f) => f.startsWith('secrets-'));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(s.dir, 'backups', backups[0]!), 'utf8')).toBe(original);

        // 换令牌、连网关、READY
        const conn = await platform.connection();
        await conn.waitFor((f) => f.op === 2);
        conn.send({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess' } });
        await until(async () => (await status(channel.id)).state === 'running');

        // 配对:私聊发「绑定 <码>」
        const pairing = (await (await req(`/api/v1/channels/${channel.id}/pairing`, { method: 'POST' })).json()) as {
            code: string;
        };
        conn.send({
            op: 0,
            s: 2,
            t: 'C2C_MESSAGE_CREATE',
            d: { id: 'msg-1', author: { user_openid: 'owner-openid-9876' }, content: `绑定 ${pairing.code}` },
        });
        await until(() => platform.sent.length === 1);
        expect(platform.sent[0]).toMatchObject({
            openid: 'owner-openid-9876',
            body: { msg_type: 0, msg_id: 'msg-1', msg_seq: 1 },
        });
        const bound = Channel.parse(await (await req(`/api/v1/channels/${channel.id}`)).json());
        expect(bound.binding?.maskedExternalUserId).toBe('****9876');
        expect(bound.qq).toEqual({ appId: APP_ID });

        // API、状态与日志里都没有 AppSecret 与令牌
        const token = platform.currentToken;
        const bodies = [
            JSON.stringify(bound),
            JSON.stringify(await status(channel.id)),
            await (await req('/api/v1/channels')).text(),
            await (await req('/api/v1/settings/egress-targets')).text(),
        ].join('\n');
        for (const secret of [APP_SECRET, token]) {
            expect(bodies).not.toContain(secret);
            expect(s.logs.join('')).not.toContain(secret);
        }
        expect(s.logs.join('')).not.toContain('owner-openid-9876');
        expect(bodies).not.toContain('QQBOT_SECRET_');

        // 删除渠道:只删这一行
        expect((await req(`/api/v1/channels/${channel.id}`, { method: 'DELETE' })).status).toBe(204);
        expect(readFileSync(secretsFile(), 'utf8')).toBe(original);
    });

    it('rejected credentials show needs-login with qq_credentials_invalid, without the secret', async () => {
        const channel = await createChannel();
        expect((await save(channel.id, { appId: APP_ID, appSecret: 'wrong-secret-value' })).status).toBe(204);
        await until(async () => (await status(channel.id)).lastError?.code === 'qq_credentials_invalid');
        const current = await status(channel.id);
        expect(current.state).toBe('needs-login');
        expect(JSON.stringify(current)).not.toContain('wrong-secret-value');
        expect(s.logs.join('')).not.toContain('wrong-secret-value');
        expect(platform.connections).toHaveLength(0);
    });

    it('does not write when secrets.yaml cannot be parsed; the file and config stay as they were', async () => {
        const broken = 'this line has no colon\n';
        writeFileSync(secretsFile(), broken, { mode: 0o600 });
        const channel = await createChannel();
        const res = await save(channel.id, { appId: APP_ID, appSecret: APP_SECRET });
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(text).not.toContain(APP_SECRET);
        expect(readFileSync(secretsFile(), 'utf8')).toBe(broken);
        expect(Channel.parse(await (await req(`/api/v1/channels/${channel.id}`)).json()).qq).toEqual({ appId: null });
        expect(s.logs.join('')).not.toContain(APP_SECRET);
    });

    it('validates the body, answers 409 for a WeChat channel, 404 for an unknown one, 401 without a session', async () => {
        const qq = await createChannel();
        expect((await save(qq.id, { appId: 'abc', appSecret: 'x' })).status).toBe(400);
        expect((await save(qq.id, { appId: APP_ID })).status).toBe(400);
        const wechat = await createChannel('wechat');
        const conflict = await save(wechat.id, { appId: APP_ID, appSecret: APP_SECRET });
        expect(conflict.status).toBe(409);
        expect(existsSync(secretsFile()) ? readFileSync(secretsFile(), 'utf8') : '').not.toContain(APP_SECRET);
        expect((await save('01JC0000000000000000000000', { appId: APP_ID, appSecret: APP_SECRET })).status).toBe(404);
        const anon = await s.app.request(`/api/v1/channels/${qq.id}/qq/credentials`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ appId: APP_ID, appSecret: APP_SECRET }),
        });
        expect(anon.status).toBe(401);
    });
});

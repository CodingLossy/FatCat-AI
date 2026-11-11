// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 微信扫码授权(ADR 0024):假的 iLink 服务器上走完扫码 → 令牌写入 secrets.yaml → 渠道用令牌长轮询 → 删除渠道删掉令牌。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Channel, ChannelStatus, WechatLoginStart, WechatLoginState } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedIlinkUrl } from './channels/wechat.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const TOKEN = 'ilink-token-abcdef-123456';

class FakeIlink {
    server: Server;
    url = '';
    qrStatus: Record<string, unknown>[] = [];
    polls: IncomingMessage['headers'][] = [];
    statusPolls = 0;

    constructor() {
        this.server = createServer((req, res) => {
            const send = (data: unknown) =>
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
            req.resume();
            const path = req.url ?? '';
            if (path.startsWith('/ilink/bot/get_bot_qrcode'))
                return send({ qrcode: 'Q1', qrcode_img_content: 'https://qr.example/Q1' });
            if (path.startsWith('/ilink/bot/get_qrcode_status')) {
                this.statusPolls += 1;
                return send(this.qrStatus.shift() ?? { status: 'wait' });
            }
            if (path.startsWith('/ilink/bot/getupdates')) {
                this.polls.push(req.headers);
                const timer = setTimeout(() => send({ ret: 0, msgs: [], get_updates_buf: 'B' }), 100);
                res.on('close', () => clearTimeout(timer));
                return;
            }
            res.writeHead(404).end();
        });
    }

    async listen() {
        await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    close() {
        this.server.closeAllConnections();
        return new Promise<void>((r) => this.server.close(() => r()));
    }
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('WeChat QR-code login', () => {
    let fake: FakeIlink;
    let s: TestServer;
    let req: (path: string, init?: RequestInit) => Promise<Response>;
    const secretsFile = () => join(s.dir, 'secrets.yaml');

    beforeEach(async () => {
        fake = new FakeIlink();
        await fake.listen();
        s = await createTestServer({}, { wechatBaseUrl: fake.url });
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
        req = async (path, init = {}) => s.app.request(path, { headers, ...init });
    });
    afterEach(async () => {
        await s.cleanup();
        await fake.close();
    });

    const createChannel = async () => {
        const channel = Channel.parse(
            await (
                await req('/api/v1/channels', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'wechat', label: '微信' }),
                })
            ).json(),
        );
        await req(`/api/v1/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
        return channel;
    };
    const status = async (id: string) => ChannelStatus.parse(await (await req(`/api/v1/channels/${id}/status`)).json());
    const loginState = async (id: string) =>
        WechatLoginState.parse(await (await req(`/api/v1/channels/${id}/wechat/login`)).json());

    it('writes the token to secrets.yaml after a confirmed scan, starts polling with it, and removes it on delete', async () => {
        const original = '# keys\nDEEPSEEK_API_KEY: sk-test-0000\n';
        writeFileSync(secretsFile(), original, { mode: 0o600 });
        const channel = await createChannel();
        await until(async () => (await status(channel.id)).state === 'needs-login');
        expect((await req(`/api/v1/channels/${channel.id}/wechat/login`)).status).toBe(404);

        fake.qrStatus.push({ status: 'scaned' }, { status: 'confirmed', bot_token: TOKEN, baseurl: fake.url });
        const res = await req(`/api/v1/channels/${channel.id}/wechat/login`, { method: 'POST' });
        expect(res.status).toBe(201);
        expect(WechatLoginStart.parse(await res.json()).qrContent).toBe('https://qr.example/Q1');
        await until(async () => (await loginState(channel.id)).state === 'confirmed');

        const key = `ILINK_TOKEN_${channel.id}`;
        expect(readFileSync(secretsFile(), 'utf8')).toBe(`${original}${key}: '${TOKEN}'\n`);
        const backups = readdirSync(join(s.dir, 'backups')).filter((f) => f.startsWith('secrets-'));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(s.dir, 'backups', backups[0]!), 'utf8')).toBe(original);

        await until(() => fake.polls.length > 0);
        expect(fake.polls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
        await until(async () => (await status(channel.id)).state === 'running');

        const body = await (await req(`/api/v1/channels/${channel.id}`)).text();
        expect(body).not.toContain(TOKEN);
        expect(body).not.toContain('ILINK_TOKEN');
        expect(s.logs.join('')).not.toContain(TOKEN);

        expect((await req(`/api/v1/channels/${channel.id}`, { method: 'DELETE' })).status).toBe(204);
        expect(readFileSync(secretsFile(), 'utf8')).toBe(original);
    });

    it('fails with secrets_write_failed and leaves secrets.yaml untouched when it does not parse', async () => {
        const broken = 'A: 1\n  nested: 2\n';
        writeFileSync(secretsFile(), broken, { mode: 0o600 });
        const channel = await createChannel();
        fake.qrStatus.push({ status: 'confirmed', bot_token: TOKEN });
        await req(`/api/v1/channels/${channel.id}/wechat/login`, { method: 'POST' });
        await until(async () => (await loginState(channel.id)).state === 'failed');
        expect(await loginState(channel.id)).toEqual({ state: 'failed', code: 'secrets_write_failed' });
        expect(readFileSync(secretsFile(), 'utf8')).toBe(broken);
        expect(s.logs.join('')).not.toContain(TOKEN);
    });

    it('stopping during the status gap does not apply that status or poll again', async () => {
        const channel = await createChannel();
        fake.qrStatus.push({ status: 'scaned' }, { status: 'confirmed', bot_token: TOKEN, baseurl: fake.url });
        expect((await req(`/api/v1/channels/${channel.id}/wechat/login`, { method: 'POST' })).status).toBe(201);
        await until(() => fake.statusPolls === 1);
        // 第一次状态已经返回,此刻正在 1 秒间隔里。只中止等待,登录记录还在,才能看出状态有没有被改掉。
        await new Promise((r) => setTimeout(r, 50));
        const watches = s.wechat as unknown as {
            logins: Map<string, { controller: AbortController }>;
        };
        watches.logins.get(channel.id)!.controller.abort();
        await new Promise((r) => setTimeout(r, 200));
        expect(fake.statusPolls).toBe(1);
        expect(await loginState(channel.id)).toEqual({ state: 'pending' });
        if (existsSync(secretsFile())) expect(readFileSync(secretsFile(), 'utf8')).not.toContain(TOKEN);
        await new Promise((r) => setTimeout(r, 900));
        expect(fake.statusPolls).toBe(1);
        expect(await loginState(channel.id)).toEqual({ state: 'pending' });
    });

    it('reports expiry and the unsupported PIN step', async () => {
        const channel = await createChannel();
        fake.qrStatus.push({ status: 'expired' });
        await req(`/api/v1/channels/${channel.id}/wechat/login`, { method: 'POST' });
        await until(async () => (await loginState(channel.id)).state === 'expired');
        fake.qrStatus.push({ status: 'need_verifycode' });
        await req(`/api/v1/channels/${channel.id}/wechat/login`, { method: 'POST' });
        await until(async () => (await loginState(channel.id)).state === 'failed');
        expect((await loginState(channel.id)).code).toBe('verify_code_required');
    });

    it('requires login and hides other ids', async () => {
        expect(
            (await s.app.request('/api/v1/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV/wechat/login', { method: 'POST' }))
                .status,
        ).toBe(401);
        expect((await req('/api/v1/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV/wechat/login', { method: 'POST' })).status).toBe(
            404,
        );
    });
});

describe('isAllowedIlinkUrl', () => {
    it('accepts only https *.qq.com without credentials', () => {
        expect(isAllowedIlinkUrl(new URL('https://ilinkai.weixin.qq.com'))).toBe(true);
        expect(isAllowedIlinkUrl(new URL('http://ilinkai.weixin.qq.com'))).toBe(false);
        expect(isAllowedIlinkUrl(new URL('https://evilqq.com'))).toBe(false);
        expect(isAllowedIlinkUrl(new URL('https://qq.com.evil.example'))).toBe(false);
        expect(isAllowedIlinkUrl(new URL('https://u:p@ilinkai.weixin.qq.com'))).toBe(false);
    });
});

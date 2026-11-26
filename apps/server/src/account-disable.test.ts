// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 停用账户时停掉它的渠道(ADR 0053 第 2、7 节):适配器被停止、外面发来的消息不再处理;
// 启用后渠道按设置重新启动,别的账户的渠道不受影响。
import { FakeChannelAdapter } from '@fatcat-ai/channels/testing';
import { Channel, LoginResponse } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

type Who = { cookie: string; csrf: string };
const call = (who: Who, method: string, path: string, body?: unknown) =>
    s.app.request(path, {
        method,
        headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

describe('停用账户与渠道', () => {
    it('停用后它的渠道停下、收不到消息;启用后重新启动;别的账户的渠道照常运行', async () => {
        const fakes = new Map<string, FakeChannelAdapter>();
        s = await createTestServer(
            {},
            {
                channelAdapters: {
                    wechat: (channel) => {
                        const fake = new FakeChannelAdapter();
                        fakes.set(channel.id, fake);
                        return fake;
                    },
                },
            },
        );
        const admin: Who = sessionFrom(
            await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
        );
        const { code } = (await (await call(admin, 'POST', '/api/v1/admin/users/invites')).json()) as { code: string };
        const accepted = await s.app.request(
            '/api/v1/auth/invite/accept',
            jsonBody({ code, username: 'kid', password: TEST_PASSWORD }),
        );
        const kid: Who = sessionFrom(accepted);
        const kidId = LoginResponse.parse(await accepted.json()).owner.id;

        const channelOf = async (who: Who) => {
            const channel = Channel.parse(
                await (await call(who, 'POST', '/api/v1/channels', { kind: 'wechat', label: '微信' })).json(),
            );
            expect((await call(who, 'PATCH', `/api/v1/channels/${channel.id}`, { enabled: true })).status).toBe(200);
            await s.channels.idle(channel.id);
            return channel;
        };
        const kidChannel = await channelOf(kid);
        const adminChannel = await channelOf(admin);
        const adminId = s.repos.owners.getByUsername('owner')!.id;
        const state = (c: Channel) =>
            s.channels.status({ id: c.id, ownerId: c.id === kidChannel.id ? kidId : adminId }).state;
        expect(state(kidChannel)).toBe('running');

        expect((await call(admin, 'PATCH', `/api/v1/admin/users/${kidId}`, { disabled: true })).status).toBe(200);
        const stopped = fakes.get(kidChannel.id)!;
        expect(stopped.stops).toBe(1);
        expect(() => stopped.deliver({ externalUserId: 'someone', text: 'hi' })).toThrow(/not running/);
        expect(state(kidChannel)).not.toBe('running');
        // 别的账户的渠道不受影响
        expect(fakes.get(adminChannel.id)!.stops).toBe(0);
        expect(state(adminChannel)).toBe('running');

        expect((await call(admin, 'PATCH', `/api/v1/admin/users/${kidId}`, { disabled: false })).status).toBe(200);
        await s.channels.idle(kidChannel.id);
        expect(state(kidChannel)).toBe('running');
        expect(fakes.get(kidChannel.id)!.ctx).not.toBeNull();
        // 渠道的设置没变:仍是启用的
        expect(s.repos.channels.get(kidId, kidChannel.id)?.enabled).toBe(true);
    });
});

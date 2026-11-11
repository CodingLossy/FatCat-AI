// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { DEFAULT_SETTINGS, Settings, TimeZoneInfo } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(() => s?.cleanup());

describe('/api/v1/settings', () => {
    it('返回默认值,PUT 只改给出的键,不存在的配置档返回 400,修改需要 CSRF', async () => {
        s = await createTestServer();
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const put = (body: unknown, withCsrf = true) =>
            s.app.request('/api/v1/settings', {
                method: 'PUT',
                headers: { cookie, 'content-type': 'application/json', ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}) },
                body: JSON.stringify(body),
            });

        const initial = await s.app.request('/api/v1/settings', { headers: { cookie } });
        expect(Settings.parse(await initial.json())).toEqual(DEFAULT_SETTINGS);

        const updated = await put({ theme: 'dark', locale: 'en' });
        expect(updated.status).toBe(200);
        expect(Settings.parse(await updated.json())).toMatchObject({ theme: 'dark', locale: 'en' });

        expect((await put({ defaultChatProfileId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).status).toBe(400);
        expect((await put({ theme: 'light' }, false)).status).toBe(403);
        expect((await s.app.request('/api/v1/settings')).status).toBe(401);
    });

    it('时区(ADR 0023):接受 IANA 名与 UTC,null 恢复跟随服务器,不合法的返回 400,变化时通知重新排期', async () => {
        const changed: string[] = [];
        s = await createTestServer({}, { onTimeZoneChanged: (_ownerId, tz) => changed.push(tz) });
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const put = (body: unknown) =>
            s.app.request('/api/v1/settings', {
                method: 'PUT',
                headers: { cookie, 'content-type': 'application/json', 'X-CSRF-Token': csrf },
                body: JSON.stringify(body),
            });
        const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const other = server === 'Asia/Shanghai' ? 'America/Los_Angeles' : 'Asia/Shanghai';

        expect(await (await put({ timeZone: other })).json()).toMatchObject({ timeZone: other });
        expect((await put({ timeZone: other })).status).toBe(200); // 没变:不再通知
        expect(await (await put({ timeZone: 'Asia/Calcutta' })).json()).toMatchObject({ timeZone: 'Asia/Calcutta' });
        for (const bad of ['+08:00', 'CST', 'Mars/Olympus']) {
            const r = await put({ timeZone: bad });
            expect(r.status, bad).toBe(400);
            expect(JSON.stringify(await r.json())).toContain('timeZone');
        }
        expect(await (await put({ timeZone: null })).json()).toMatchObject({ timeZone: null });
        expect(changed).toEqual([other, 'Asia/Calcutta', server]);
        // 改别的设置不影响时区
        expect(await (await put({ theme: 'dark' })).json()).toMatchObject({ timeZone: null, theme: 'dark' });
    });

    it('GET /settings/time-zones 需要登录,列表含 UTC 与服务器时区', async () => {
        s = await createTestServer();
        expect((await s.app.request('/api/v1/settings/time-zones')).status).toBe(401);
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie } = sessionFrom(res);
        const info = TimeZoneInfo.parse(
            await (await s.app.request('/api/v1/settings/time-zones', { headers: { cookie } })).json(),
        );
        expect(info.serverTimeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(info.supported).toContain('UTC');
        expect(info.supported).toContain('Asia/Shanghai');
    });
});

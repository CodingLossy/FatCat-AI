// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { DEFAULT_SETTINGS, Settings } from '@ai-personal/shared';
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
});

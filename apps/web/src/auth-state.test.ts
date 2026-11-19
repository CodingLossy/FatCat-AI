// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { FatCatNetworkError } from '@fatcat-ai/client';
import type { AuthStatus, Settings } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { type AuthDeps, resolveAuth } from './auth-state.js';

const SETTINGS = { theme: 'system', locale: 'zh-CN' } as unknown as Settings;
const signedIn: AuthStatus = { initialized: true, authenticated: true };
const signedOut: AuthStatus = { initialized: true, authenticated: false };

function setup(opts: {
    statuses: (AuthStatus | Error)[];
    paired: () => boolean;
    refresh: () => Promise<boolean>;
    offlineSettings?: Settings | null;
}) {
    const calls = { cleared: 0, remembered: 0, refreshed: 0 };
    const statuses = [...opts.statuses];
    const deps: AuthDeps = {
        status: () => {
            const next = statuses.shift()!;
            return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
        settings: () => Promise.resolve(SETTINGS),
        isOffline: (e) => e instanceof FatCatNetworkError,
        device: {
            isPaired: opts.paired,
            refresh: () => {
                calls.refreshed += 1;
                return opts.refresh();
            },
        },
        cache: {
            remember: () => void (calls.remembered += 1),
            clear: () => Promise.resolve(void (calls.cleared += 1)),
            offlineStartup: () => Promise.resolve(opts.offlineSettings ?? null),
        },
    };
    return { deps, calls };
}

describe('resolveAuth', () => {
    it('设备令牌过期(status 答 200 未登录)时先 refresh 再重新判断,不清缓存', async () => {
        const { deps, calls } = setup({
            statuses: [signedOut, signedIn],
            paired: () => true,
            refresh: async () => true,
        });
        const result = await resolveAuth(deps);
        expect(result.status.authenticated).toBe(true);
        expect(calls).toEqual({ cleared: 0, remembered: 1, refreshed: 1 });
    });

    it('refresh 被服务器拒绝(设备已吊销,本机令牌已清掉)时清空缓存并显示未登录', async () => {
        let paired = true;
        const { deps, calls } = setup({
            statuses: [signedOut],
            paired: () => paired,
            refresh: async () => {
                paired = false; // 真实实现在 401 时 forget()
                return false;
            },
        });
        const result = await resolveAuth(deps);
        expect(result.status.authenticated).toBe(false);
        expect(calls.cleared).toBe(1);
    });

    it('refresh 因网络问题失败(设备还在)时按离线处理:不清缓存,用离线缓存启动', async () => {
        const { deps, calls } = setup({
            statuses: [signedOut],
            paired: () => true,
            refresh: async () => false,
            offlineSettings: SETTINGS,
        });
        const result = await resolveAuth(deps);
        expect(result.status.authenticated).toBe(true);
        expect(calls.cleared).toBe(0);
    });

    it('没有配对设备、服务器答未登录:清缓存,不尝试 refresh', async () => {
        const { deps, calls } = setup({ statuses: [signedOut], paired: () => false, refresh: async () => true });
        await resolveAuth(deps);
        expect(calls).toMatchObject({ cleared: 1, refreshed: 0 });
    });
});

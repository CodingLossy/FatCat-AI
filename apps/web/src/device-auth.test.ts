// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { FatCatApiError } from '@fatcat-ai/client';
import type { DeviceTokens } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { DeviceAuth, localDeviceStore } from './device-auth.js';
import { takePairingCode } from './pair-code.js';

const NOW = Date.parse('2026-11-19T00:00:00Z');
const tokens = (n: number, accessInMs = 15 * 60_000): DeviceTokens =>
    ({
        device: { id: 'dev1' },
        accessToken: `aip_dev_${n}`,
        accessExpiresAt: new Date(NOW + accessInMs).toISOString(),
        refreshToken: `aip_ref_${n}`,
        refreshExpiresAt: new Date(NOW + 90 * 86_400_000).toISOString(),
    }) as unknown as DeviceTokens;

function memoryStorage() {
    const data = new Map<string, string>();
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    };
}

// 用一个简单的排队锁模拟 Web Locks
function queueLock() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(_name: string, fn: () => Promise<T>) => {
        const run = tail.then(fn);
        tail = run.catch(() => undefined);
        return run;
    };
}

function setup(exchange: (refresh: string) => Promise<DeviceTokens>) {
    const store = localDeviceStore(memoryStorage());
    const auth = new DeviceAuth({ store, exchange, now: () => NOW, lock: queueLock() });
    return { store, auth };
}

describe('DeviceAuth', () => {
    it('两个标签页同时刷新只换一次,第二个直接用已经换好的令牌(避免重放吊销)', async () => {
        const used: string[] = [];
        const { auth } = setup((r) => {
            used.push(r);
            return Promise.resolve(tokens(2));
        });
        auth.adopt(tokens(1));
        const results = await Promise.all([auth.refresh('aip_dev_1'), auth.refresh('aip_dev_1')]);
        expect(results).toEqual([true, true]);
        expect(used).toEqual(['aip_ref_1']);
        expect(auth.accessToken()).toBe('aip_dev_2');
    });

    it('服务器拒绝 refresh(401)时清除本机令牌,网络错误则保留', async () => {
        const rejected = setup(() =>
            Promise.reject(
                new FatCatApiError({
                    type: 'about:blank',
                    title: 'x',
                    status: 401,
                    code: 'unauthorized',
                    requestId: 'r',
                }),
            ),
        );
        rejected.auth.adopt(tokens(1));
        expect(await rejected.auth.refresh()).toBe(false);
        expect(rejected.auth.isPaired()).toBe(false);

        const offline = setup(() => Promise.reject(new TypeError('network')));
        offline.auth.adopt(tokens(1));
        expect(await offline.auth.refresh()).toBe(false);
        expect(offline.auth.isPaired()).toBe(true);
    });
});

describe('takePairingCode', () => {
    it('读出合法配对码并把它从地址栏去掉;格式不对的返回空', () => {
        const replaced: string[] = [];
        expect(takePairingCode('?code=ABCDE-12345', (u) => replaced.push(u))).toBe('ABCDE-12345');
        expect(replaced).toEqual(['/pair']);
        expect(takePairingCode('?code=not-a-code!', () => undefined)).toBe('');
        expect(takePairingCode('', (u) => replaced.push(u))).toBe('');
        expect(replaced).toEqual(['/pair']);
    });
});

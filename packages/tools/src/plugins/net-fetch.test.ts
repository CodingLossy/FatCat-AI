// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { NetScopeError, pluginNetFetch } from './net-fetch.js';

const resolve = async () => [{ address: '93.184.216.34', family: 4 }];

describe('pluginNetFetch scope checks', () => {
    it('rejects plain http', async () => {
        await expect(
            pluginNetFetch({ url: 'http://example.com/' }, { domains: ['example.com'], resolve }),
        ).rejects.toThrow(/only https/);
    });

    it('rejects a host outside the granted domains', async () => {
        await expect(
            pluginNetFetch({ url: 'https://evil.test/' }, { domains: ['example.com'], resolve }),
        ).rejects.toBeInstanceOf(NetScopeError);
    });

    it('rejects malformed params', async () => {
        await expect(pluginNetFetch({ url: 42 }, { domains: ['example.com'], resolve })).rejects.toThrow();
    });
});

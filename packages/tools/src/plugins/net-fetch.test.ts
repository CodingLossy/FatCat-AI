// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it, vi } from 'vitest';
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

describe('pluginNetFetch result mapping', () => {
    const fetched = (contentType: string, body: Buffer) => ({
        status: 200,
        headers: { 'content-type': contentType },
        contentType,
        body,
        truncated: false,
    });

    it('returns text bodies as utf8 and binary bodies as base64, passing the scope hook', async () => {
        const web = await import('../builtin/web-fetch.js');
        const spy = vi.spyOn(web, 'guardedFetch');
        spy.mockImplementationOnce(async (_url, options) => {
            options?.onUrl?.(new URL('https://example.com/a'));
            return fetched('application/json', Buffer.from('{"a":1}')) as never;
        });
        const text = await pluginNetFetch(
            { url: 'https://example.com/a' },
            { domains: ['example.com'], allowFakeIp: true },
        );
        expect(text).toMatchObject({ status: 200, body: '{"a":1}', bodyEncoding: 'utf8', truncated: false });

        spy.mockImplementationOnce(async () => fetched('image/png', Buffer.from([1, 2, 3])) as never);
        const bin = await pluginNetFetch({ url: 'https://example.com/b' }, { domains: ['example.com'] });
        expect(bin).toMatchObject({ body: 'AQID', bodyEncoding: 'base64' });
        spy.mockRestore();
    });
});

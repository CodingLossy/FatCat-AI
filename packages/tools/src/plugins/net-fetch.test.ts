// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createServer, type Server } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './fixtures/test-tls.js';
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

describe('pluginNetFetch against a local https server', () => {
    let main: Server;
    let other: Server;
    let mainPort = 0;
    let otherPort = 0;
    let otherHits = 0;
    let previousCAs: string[] = [];
    const options = {
        domains: ['ok.test', '*.wild.test'],
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        isBlocked: (address: string) => address !== '127.0.0.1',
    };
    const listen = (server: Server) =>
        new Promise<number>((done) =>
            server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)),
        );

    beforeAll(async () => {
        // 只信任这张测试证书(附加到默认 CA 之后),结束后恢复默认
        previousCAs = getCACertificates('default');
        setDefaultCACertificates([...previousCAs, TEST_TLS_CERT]);
        other = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
            otherHits++;
            res.end('other');
        });
        otherPort = await listen(other);
        main = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
            const path = req.url ?? '/';
            if (path === '/text') {
                res.setHeader('set-cookie', 'a=b');
                res.setHeader('content-type', 'text/plain');
                res.end('hello');
            } else if (path === '/bin') {
                res.setHeader('content-type', 'application/octet-stream');
                res.end(Buffer.from([1, 2, 3]));
            } else if (path === '/same') {
                res.statusCode = 302;
                res.setHeader('location', `https://ok.test:${mainPort}/text`);
                res.end();
            } else if (path === '/out') {
                res.statusCode = 302;
                res.setHeader('location', `https://evil.test:${otherPort}/`);
                res.end();
            } else if (path === '/meta') {
                res.statusCode = 302;
                res.setHeader('location', 'https://169.254.169.254/latest/meta-data');
                res.end();
            } else if (path === '/downgrade') {
                res.statusCode = 302;
                res.setHeader('location', `http://ok.test:${mainPort}/text`);
                res.end();
            } else {
                res.end('x');
            }
        });
        mainPort = await listen(main);
    });

    afterAll(async () => {
        setDefaultCACertificates(previousCAs);
        await Promise.all([main, other].map((s) => new Promise((done) => s.close(done))));
    });

    const get = (path: string, opts = options) => pluginNetFetch({ url: `https://ok.test:${mainPort}${path}` }, opts);

    it('returns text as utf8 and binary as base64, without set-cookie', async () => {
        const text = await get('/text');
        expect(text).toMatchObject({ status: 200, body: 'hello', bodyEncoding: 'utf8' });
        expect(Object.keys(text.headers ?? {})).not.toContain('set-cookie');
        expect(await get('/bin')).toMatchObject({ body: 'AQID', bodyEncoding: 'base64' });
    });

    it('follows redirects inside the granted domains', async () => {
        expect(await get('/same')).toMatchObject({ body: 'hello' });
    });

    it('refuses redirects out of scope, to metadata addresses, and downgrades to http', async () => {
        await expect(get('/out')).rejects.toBeInstanceOf(NetScopeError);
        expect(otherHits).toBe(0);
        await expect(get('/meta')).rejects.toThrow(/not allowed/);
        await expect(get('/downgrade')).rejects.toThrow(/only https/);
    });

    it('does not follow redirects for POST', async () => {
        await expect(
            pluginNetFetch({ url: `https://ok.test:${mainPort}/same`, method: 'POST', body: 'x' }, options),
        ).rejects.toThrow(/redirects are not followed for POST/);
    });

    it('rejects forbidden request headers during validation', async () => {
        for (const name of ['Cookie', 'Host', 'Proxy-Authorization']) {
            await expect(
                pluginNetFetch({ url: `https://ok.test:${mainPort}/text`, headers: { [name]: 'x' } }, options),
            ).rejects.toThrow();
        }
    });

    it('matches wildcard domains on label boundaries only', async () => {
        const check = (host: string) =>
            pluginNetFetch({ url: `https://${host}:${mainPort}/text` }, { ...options, domains: ['*.ok.test'] });
        await expect(check('evilok.test')).rejects.toBeInstanceOf(NetScopeError);
        await expect(
            pluginNetFetch({ url: `https://ok.test.evil:${mainPort}/text` }, { ...options, domains: ['ok.test'] }),
        ).rejects.toBeInstanceOf(NetScopeError);
    });
});

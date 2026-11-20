// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    BrowserError,
    checkBrowserUrl,
    createBrowserTools,
    decide,
    isBlockedAddress,
    type BrowserToolOptions,
    type ToolContext,
    type ToolDefinition,
} from './index.js';

const ctx: ToolContext = {
    ownerId: 'o',
    sessionId: 's1',
    runId: 'r1',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

describe('browser.*(本机测试服务器)', () => {
    let server: Server;
    let port = 0;
    let cookieSeen: string | undefined = 'unset';
    const hang: (() => void)[] = [];

    const LOCAL = '127.0.0.1';
    // 测试中把 127.0.0.1 视为「公网」,其他地址照常校验
    const isBlocked = (ip: string) => ip !== LOCAL && isBlockedAddress(ip);
    const hosts: Record<string, string[]> = {
        'site.test': [LOCAL],
        'other.test': [LOCAL],
        'private.test': ['10.0.0.5'],
        'rebind.test': [LOCAL, '192.168.0.10'],
        'metadata.test': ['169.254.169.254'],
    };
    const resolve = (host: string): Promise<LookupAddress[]> => {
        const list = hosts[host];
        return list
            ? Promise.resolve(list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
            : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
    };
    const url = (host: string, path: string) => `http://${host}:${port}${path}`;

    beforeAll(async () => {
        server = createServer((req, res) => {
            const path = req.url ?? '/';
            cookieSeen = req.headers.cookie;
            const html = (body: string) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'a=1' });
                res.end(body);
            };
            if (path === '/ok')
                html('<html><title>Hello</title><body><p>First paragraph.</p><script>x()</script></body></html>');
            else if (path === '/long') html(`<title>Long</title><p>${'abcdefghij'.repeat(3000)}</p>`);
            else if (path === '/same') {
                res.writeHead(302, { location: `http://site.test:${port}/ok` });
                res.end();
            } else if (path === '/to-private') {
                res.writeHead(302, { location: 'http://10.0.0.5/' });
                res.end();
            } else if (path === '/to-loopback-name') {
                res.writeHead(302, { location: `http://localhost:${port}/ok` });
                res.end();
            } else if (path === '/to-file') {
                res.writeHead(302, { location: 'file:///etc/passwd' });
                res.end();
            } else if (path === '/to-other') {
                res.writeHead(302, { location: `http://other.test:${port}/ok` });
                res.end();
            } else if (path === '/to-rebind') {
                res.writeHead(302, { location: `http://rebind.test:${port}/ok` });
                res.end();
            } else if (path === '/big') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('x'.repeat(3 * 1024 * 1024));
            } else if (path === '/png') {
                res.writeHead(200, { 'content-type': 'image/png' });
                res.end(Buffer.from([0x89, 0x50]));
            } else if (path === '/404') {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('no');
            } else if (path === '/hang') {
                hang.push(() => res.destroy());
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise<void>((done) => server.listen(0, LOCAL, done));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const close of hang) close();
        await new Promise<void>((done) => server.close(() => done()));
    });

    let on = true;
    const make = (extra: Partial<BrowserToolOptions> = {}) => {
        const tools = createBrowserTools({
            enabled: () => on,
            fetch: { resolve, isBlocked },
            ...extra,
        });
        const by = (name: string) => tools.find((t) => t.name === name)!;
        return { open: by('browser.open'), read: by('browser.read'), screenshot: by('browser.screenshot') };
    };
    const ask = (tool: ToolDefinition, input: unknown, context: ToolContext = ctx) => decide(tool, input, context, []);

    it('设置里的开关关闭时三个工具都被拒绝,而且不会弹审批', () => {
        on = false;
        const { open, read, screenshot } = make();
        for (const [tool, input] of [
            [open, { url: 'https://example.com/' }],
            [read, {}],
            [screenshot, {}],
        ] as const) {
            expect(ask(tool, input)).toMatchObject({ action: 'deny', reason: expect.stringContaining('turned off') });
        }
        on = true;
    });

    it.each([
        'file:///etc/passwd',
        'ftp://example.com/',
        'javascript:alert(1)',
        'http://localhost/',
        'http://app.localhost:8787/',
        'http://127.0.0.1:8787/',
        'http://127.1/',
        'http://2130706433/',
        'http://10.1.2.3/',
        'http://172.16.0.1/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
        'http://[fc00::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://8.8.8.8/',
        'http://printer/',
        'http://nas.local/',
        'http://user:pw@example.com/',
        'not a url',
    ])('在审批之前直接拒绝 %s', (target) => {
        const { open } = make();
        expect(ask(open, { url: target })).toMatchObject({ action: 'deny' });
        expect(() => checkBrowserUrl(target)).toThrow(BrowserError);
    });

    it('公网域名需要审批;同会话同主机之后不再询问,别的主机和别的会话仍然询问', async () => {
        const { open } = make();
        expect(ask(open, { url: url('site.test', '/ok') })).toEqual({ action: 'ask' });
        await open.execute({ url: url('site.test', '/ok') }, ctx);
        expect(ask(open, { url: url('site.test', '/other') })).toMatchObject({ action: 'run' });
        // 读过不可信内容之后(untrustedContentSeen)同一主机也不再问
        expect(ask(open, { url: url('site.test', '/ok') }, { ...ctx, untrustedContentSeen: true })).toMatchObject({
            action: 'run',
        });
        expect(ask(open, { url: url('other.test', '/ok') })).toEqual({ action: 'ask' });
        expect(ask(open, { url: url('site.test', '/ok') }, { ...ctx, sessionId: 's2' })).toEqual({ action: 'ask' });
    });

    it('open 之后 read 返回已包装的不可信正文,去掉脚本,不联网', async () => {
        const { open, read } = make();
        const c = { ...ctx, sessionId: 'read-1' };
        const opened = (await open.execute({ url: url('site.test', '/ok') }, c)) as {
            untrusted: boolean;
            content: string;
        };
        expect(opened.untrusted).toBe(true);
        expect(opened.content).toContain('Title: Hello');
        const page = (await read.execute({}, c)) as { untrusted: boolean; content: string; source: { kind: string } };
        expect(page).toMatchObject({ untrusted: true, source: { kind: 'web' }, truncated: false });
        expect(page.content).toContain('First paragraph.');
        expect(page.content).not.toContain('x()');
        expect(read.untrustedOutput).toBe(true);
        expect(open.untrustedOutput).toBe(true);
        // read 本身不联网:服务器关掉也能读
    });

    it('read 分页,且长度有上限', async () => {
        const { open, read } = make();
        const c = { ...ctx, sessionId: 'page-1' };
        await open.execute({ url: url('site.test', '/long') }, c);
        const first = (await read.execute({ maxChars: 1000 }, c)) as { content: string; truncated: boolean };
        expect(first.content.length).toBeLessThan(1100);
        expect(first.truncated).toBe(true);
        const second = (await read.execute({ offset: 1000, maxChars: 50 }, c)) as { content: string };
        expect(second.content).toHaveLength(50);
        await expect(read.execute({ maxChars: 20_001 }, c)).rejects.toThrow();
        await expect(read.execute({ extra: 1 }, c)).rejects.toThrow();
    });

    it('没有打开页面时 read / screenshot 报错', async () => {
        const { read, screenshot } = make();
        const c = { ...ctx, sessionId: 'empty' };
        await expect(read.execute({}, c)).rejects.toMatchObject({ code: 'no_page' });
        await expect(screenshot.execute({}, c)).rejects.toMatchObject({ code: 'no_page' });
    });

    it('主机名解析到内网 / 元数据地址,或同时解析到内网与公网(DNS 重绑定)时拒绝', async () => {
        const { open } = make();
        for (const host of ['private.test', 'metadata.test', 'rebind.test']) {
            await expect(
                open.execute({ url: url(host, '/ok') }, { ...ctx, sessionId: `dns-${host}` }),
            ).rejects.toMatchObject({
                code: 'blocked_address',
            });
        }
    });

    it('重定向:同主机放行;到内网、本机名、file: 、没有批准过的主机、重绑定主机都拒绝', async () => {
        const { open } = make();
        const c = { ...ctx, sessionId: 'redir' };
        await expect(open.execute({ url: url('site.test', '/same') }, c)).resolves.toMatchObject({ untrusted: true });
        for (const path of ['/to-private', '/to-loopback-name', '/to-file']) {
            await expect(open.execute({ url: url('site.test', path) }, c)).rejects.toThrow();
        }
        await expect(open.execute({ url: url('site.test', '/to-other') }, c)).rejects.toMatchObject({
            code: 'redirect_new_host',
        });
        await expect(open.execute({ url: url('site.test', '/to-rebind') }, c)).rejects.toMatchObject({
            code: 'redirect_new_host',
        });
        // 即使重绑定主机已被批准过,解析到内网地址的连接仍然被拒绝
        await open.execute({ url: url('other.test', '/ok') }, c);
        await expect(open.execute({ url: url('site.test', '/to-other') }, c)).resolves.toMatchObject({
            untrusted: true,
        });
    });

    it('不带 cookie,也不保存服务器设置的 cookie', async () => {
        const { open } = make();
        cookieSeen = 'unset';
        const c = { ...ctx, sessionId: 'cookie' };
        await open.execute({ url: url('site.test', '/ok') }, c);
        expect(cookieSeen).toBeUndefined();
        await open.execute({ url: url('site.test', '/ok') }, c);
        expect(cookieSeen).toBeUndefined();
    });

    it('超大响应被截断并标记;错误状态码与非文本类型报错', async () => {
        const { open, read } = make({ fetch: { resolve, isBlocked, maxBytes: 4096 } });
        const c = { ...ctx, sessionId: 'big' };
        await open.execute({ url: url('site.test', '/big') }, c);
        const page = (await read.execute({ maxChars: 20_000 }, c)) as { content: string; truncated: boolean };
        expect(page.truncated).toBe(true);
        expect(page.content.length).toBeLessThanOrEqual(4096 + 20);
        await expect(open.execute({ url: url('site.test', '/404') }, c)).rejects.toMatchObject({ code: 'http_error' });
        await expect(open.execute({ url: url('site.test', '/png') }, c)).rejects.toMatchObject({
            code: 'unsupported_type',
        });
    });

    it('响应超时', async () => {
        const { open } = make({ fetch: { resolve, isBlocked, timeoutMs: 150 } });
        await expect(open.execute({ url: url('site.test', '/hang') }, { ...ctx, sessionId: 'hang' })).rejects.toThrow(
            /no response within 150 ms/,
        );
    });

    it('并发上限:超过时返回 busy', async () => {
        const { open } = make({ fetch: { resolve, isBlocked, timeoutMs: 400 }, maxConcurrent: 1 });
        const slow = open.execute({ url: url('site.test', '/hang') }, { ...ctx, sessionId: 'c1', runId: 'rc1' });
        slow.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        await expect(
            open.execute({ url: url('site.test', '/ok') }, { ...ctx, sessionId: 'c2', runId: 'rc2' }),
        ).rejects.toMatchObject({ code: 'busy' });
        await expect(slow).rejects.toThrow();
    });

    it('每次运行最多 N 次调用', async () => {
        const { open, read } = make({ maxCallsPerRun: 3 });
        const c = { ...ctx, sessionId: 'limit', runId: 'run-limit' };
        await open.execute({ url: url('site.test', '/ok') }, c);
        await read.execute({}, c);
        await read.execute({}, c);
        await expect(read.execute({}, c)).rejects.toMatchObject({ code: 'run_limit' });
        // 另一次运行从零开始
        await expect(read.execute({}, { ...c, runId: 'run-limit-2' })).resolves.toMatchObject({ untrusted: true });
    });

    it('截图:没有宿主适配器时返回 browser_unavailable;有适配器时只返回元数据并交给宿主;过大或超时拒绝', async () => {
        const c = { ...ctx, sessionId: 'shot' };
        const none = make();
        await none.open.execute({ url: url('site.test', '/ok') }, c);
        await expect(none.screenshot.execute({}, c)).rejects.toMatchObject({ code: 'browser_unavailable' });

        const delivered: { url: string; bytes: number }[] = [];
        const ok = make({
            host: {
                screenshot: async () => ({ mimeType: 'image/png', width: 10, height: 5, bytes: new Uint8Array(100) }),
            },
            onScreenshot: (_context, image, shotUrl) => delivered.push({ url: shotUrl, bytes: image.bytes.length }),
        });
        await ok.open.execute({ url: url('site.test', '/ok') }, c);
        const result = (await ok.screenshot.execute({}, c)) as { content: string };
        expect(result.content).toContain('10x5');
        expect(JSON.stringify(result)).not.toContain('base64');
        expect(delivered).toEqual([{ url: expect.stringContaining('site.test'), bytes: 100 }]);

        const huge = make({
            host: {
                screenshot: async () => ({
                    mimeType: 'image/png',
                    width: 1,
                    height: 1,
                    bytes: new Uint8Array(4 * 1024 * 1024 + 1),
                }),
            },
        });
        await huge.open.execute({ url: url('site.test', '/ok') }, c);
        await expect(huge.screenshot.execute({}, c)).rejects.toMatchObject({ code: 'too_large' });

        const slow = make({
            screenshotTimeoutMs: 50,
            host: {
                screenshot: (_url, signal) =>
                    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
            },
        });
        await slow.open.execute({ url: url('site.test', '/ok') }, c);
        await expect(slow.screenshot.execute({}, c)).rejects.toMatchObject({ code: 'timeout' });
    });

    it('地址里带很长的查询串时审批显示「携带数据」警示;宽泛预授权不被接受', () => {
        const { open } = make();
        const long = `https://example.com/?q=${'a'.repeat(300)}`;
        expect(open.warnings?.({ url: long }, ctx)).toEqual([expect.objectContaining({ code: 'url_carries_data' })]);
        expect(open.warnings?.({ url: 'https://example.com/?q=1' }, ctx)).toEqual([]);
        expect(open.requireConstraint).toBe('domain');
        expect(() => open.normalizeConstraint?.domain?.('*', { ownerId: 'o' })).toThrow();
    });
});

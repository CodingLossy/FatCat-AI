// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    checkRemember,
    checkUrl,
    createCalcTool,
    createTimeTool,
    createWebFetchTool,
    evaluate,
    guardedFetch,
    htmlToText,
    isBlockedAddress,
    type ToolContext,
} from './index.js';

const ctx: ToolContext = {
    ownerId: 'o',
    sessionId: 's',
    runId: 'r',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

describe('calc', () => {
    it.each([
        ['1 + 2 * 3', 7],
        ['(1 + 2) * 3', 9],
        ['2 ^ 3 ^ 2', 512],
        ['-2 ^ 2', -4],
        ['--3', 3],
        ['7 % 3', 1],
        ['10 / 4', 2.5],
        ['1.5e3 + .5', 1500.5],
        ['sqrt(16) + abs(-2) + max(1, 5, 3) + min(4, 2)', 13],
        ['round(pi * 100) / 100', 3.14],
        ['log(1000) + log2(8) + ln(e)', 7],
        ['pow(2, 10)', 1024],
        ['3 × 4 ÷ 2', 6],
    ])('%s = %d', (expression, expected) => {
        expect(evaluate(expression)).toBeCloseTo(expected, 10);
    });

    it('结果去掉浮点误差的尾巴', async () => {
        expect(await createCalcTool().execute({ expression: '0.1 + 0.2' }, ctx)).toEqual({
            expression: '0.1 + 0.2',
            result: 0.3,
        });
    });

    it.each([
        ['1 / 0', /division by zero/],
        ['5 % 0', /division by zero/],
        ['', /empty/],
        ['1 +', /unexpected end/],
        ['(1 + 2', /expected "\)"/],
        ['1 2', /unexpected "2"/],
        ['sqrt(1, 2)', /takes 1 argument/],
        ['foo(1)', /unknown name "foo"/],
        ['10 ^ 400', /not a finite number/],
        ['1..2', /invalid number|unexpected/],
        ['2 # 3', /unexpected character/],
    ])('拒绝 %s', (expression, error) => {
        expect(() => evaluate(expression)).toThrow(error);
    });

    it.each([
        "require('fs')",
        'process.exit(1)',
        'constructor.constructor("return process")()',
        '__proto__',
        'this',
        '`1`',
        'globalThis',
    ])('注入:不执行任何代码,%s 被当作非法表达式', (expression) => {
        expect(() => evaluate(expression)).toThrow();
    });

    it('长度与嵌套深度有上限', () => {
        expect(() => evaluate('1+'.repeat(300) + '1')).toThrow(/longer than/);
        expect(() => evaluate('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested too deeply/);
        expect(() => evaluate('-'.repeat(100) + '1')).toThrow(/nested too deeply/);
    });
});

describe('time', () => {
    const fixed = () => new Date('2026-11-04T07:30:00.000Z');

    it('按指定时区返回本地时间与偏移', async () => {
        expect(await createTimeTool(fixed).execute({ timezone: 'Asia/Shanghai' }, ctx)).toEqual({
            timezone: 'Asia/Shanghai',
            local: '2026-11-04 15:30:00',
            weekday: 'Wednesday',
            utcOffset: 'GMT+8',
            iso: '2026-11-04T07:30:00.000Z',
            unix: 1793777400,
        });
        expect(await createTimeTool(fixed).execute(undefined, ctx)).toMatchObject({ iso: '2026-11-04T07:30:00.000Z' });
        await expect(createTimeTool(fixed).execute({ timezone: 'Mars/Olympus' }, ctx)).rejects.toThrow(
            /unknown time zone/,
        );
    });

    it('time:不传 timezone 时用用户时区(ADR 0023),显式传的照旧', async () => {
        const fixed = () => new Date('2026-11-10T17:00:00Z');
        const tool = createTimeTool(fixed, (ownerId) => (ownerId === ctx.ownerId ? 'Asia/Shanghai' : 'UTC'));
        expect(await tool.execute(undefined, ctx)).toMatchObject({
            timezone: 'Asia/Shanghai',
            local: '2026-11-11 01:00:00',
        });
        expect(await tool.execute({ timezone: 'UTC' }, ctx)).toMatchObject({
            timezone: 'UTC',
            local: '2026-11-10 17:00:00',
        });
    });
});

describe('SSRF:地址与 URL 校验', () => {
    it.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '255.255.255.255',
        '::1',
        '::',
        'fe80::1',
        'fc00::1',
        'fd00:ec2::254',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '::ffff:169.254.169.254',
        '64:ff9b::a00:1',
        '::127.0.0.1',
        'not-an-ip',
    ])('拒绝 %s', (ip) => {
        expect(isBlockedAddress(ip)).toBe(true);
    });

    it.each(['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
        '允许公网地址 %s',
        (ip) => {
            expect(isBlockedAddress(ip)).toBe(false);
        },
    );

    it.each([
        ['file:///etc/passwd', /only http and https/],
        ['ftp://example.com/', /only http and https/],
        ['javascript:alert(1)', /only http and https/],
        ['http://user:pass@example.com/', /credentials/],
        ['http://127.0.0.1/', /not allowed/],
        ['http://[::1]:8787/', /not allowed/],
        ['http://169.254.169.254/latest/meta-data/', /not allowed/],
        ['http://2130706433/', /not allowed/],
        ['http://0x7f.1/', /not allowed/],
        ['http://[::ffff:127.0.0.1]/', /not allowed/],
        ['not a url', /not valid/],
    ])('拒绝 URL %s', (url, error) => {
        expect(() => checkUrl(url)).toThrow(error);
    });
});

describe('web.fetch(本机测试服务器)', () => {
    let server: Server;
    let port = 0;
    let hang: (() => void)[] = [];

    // 测试中把 127.0.0.1 视为「公网」,其他地址照常校验;主机名由假的解析器解析
    const LOCAL = '127.0.0.1';
    const isBlocked = (ip: string) => ip !== LOCAL && isBlockedAddress(ip);
    const hosts: Record<string, string[]> = {
        'site.test': [LOCAL],
        'private.test': ['10.0.0.5'],
        'rebind.test': [LOCAL, '192.168.0.10'],
    };
    const resolve = (host: string): Promise<LookupAddress[]> => {
        const list = hosts[host];
        return list
            ? Promise.resolve(list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
            : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
    };
    const options = { resolve, isBlocked };
    const url = (host: string, path: string) => `http://${host}:${port}${path}`;

    beforeAll(async () => {
        server = createServer((req, res) => {
            const path = req.url ?? '/';
            if (path === '/page') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(
                    '<!doctype html><html><head><title>测试 &amp; 页面</title><style>p{}</style></head><body>' +
                        '<h1>标题</h1><p>第一段&nbsp;文字。</p><script>alert(1)</script><p>第二段 &#x4F60;&#22909;</p></body></html>',
                );
            } else if (path === '/json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ok":true}');
            } else if (path === '/big') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('x'.repeat(5000));
            } else if (path === '/image') {
                res.writeHead(200, { 'content-type': 'image/png' });
                res.end(Buffer.from([0x89, 0x50]));
            } else if (path === '/missing') {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('nope');
            } else if (path.startsWith('/redirect?to=')) {
                res.writeHead(302, { location: decodeURIComponent(path.slice('/redirect?to='.length)) });
                res.end();
            } else if (path === '/loop') {
                res.writeHead(301, { location: '/loop' });
                res.end();
            } else if (path === '/hang') {
                hang.push(() => res.end());
            } else {
                res.writeHead(500);
                res.end();
            }
        });
        await new Promise<void>((r) => server.listen(0, LOCAL, () => r()));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const h of hang) h();
        hang = [];
        await new Promise<void>((r) => server.close(() => r()));
    });

    it('HTML 转为纯文本,去掉脚本与样式,包上不可信标记', async () => {
        const output = await createWebFetchTool(options).execute({ url: url('site.test', '/page') }, ctx);
        expect(output).toEqual({
            untrusted: true,
            source: { kind: 'web', ref: url('site.test', '/page') },
            content: '测试 & 页面\n\n标题\n\n第一段 文字。\n\n第二段 你好',
            truncated: false,
        });
        const json = await createWebFetchTool(options).execute({ url: url('site.test', '/json') }, ctx);
        expect(json).toMatchObject({ content: '{"ok":true}' });
    });

    it('DNS 解析到内网、DNS 重绑定(任一地址为内网)、跳转到内网都被拒绝', async () => {
        await expect(guardedFetch(url('private.test', '/page'), options)).rejects.toThrow(
            /disallowed address \(10\.0\.0\.5\)/,
        );
        await expect(guardedFetch(url('rebind.test', '/page'), options)).rejects.toThrow(/192\.168\.0\.10/);
        const toPrivate = encodeURIComponent(url('private.test', '/page'));
        await expect(guardedFetch(url('site.test', `/redirect?to=${toPrivate}`), options)).rejects.toThrow(
            /disallowed address/,
        );
        const toMetadata = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
        await expect(guardedFetch(url('site.test', `/redirect?to=${toMetadata}`), options)).rejects.toThrow(
            /169\.254\.169\.254 is not allowed/,
        );
        const toFile = encodeURIComponent('file:///etc/passwd');
        await expect(guardedFetch(url('site.test', `/redirect?to=${toFile}`), options)).rejects.toThrow(
            /only http and https/,
        );
        // 不覆盖 isBlocked 时,本机地址本身也被拒绝
        await expect(guardedFetch(url('site.test', '/page'), { resolve })).rejects.toThrow(/127\.0\.0\.1/);
        await expect(guardedFetch(url('unknown.test', '/page'), options)).rejects.toThrow(/ENOTFOUND/);
    });

    it('跳转最多 5 次;正文超过上限时截断;超时报错;非文本与 4xx 报错', async () => {
        const redirected = await guardedFetch(url('site.test', `/redirect?to=${encodeURIComponent('/json')}`), options);
        expect(redirected).toMatchObject({ url: url('site.test', '/json'), status: 200 });
        await expect(guardedFetch(url('site.test', '/loop'), options)).rejects.toThrow(/more than 5 redirects/);

        const big = await guardedFetch(url('site.test', '/big'), { ...options, maxBytes: 1000 });
        expect(big.body.length).toBe(1000);
        expect(big.truncated).toBe(true);

        await expect(guardedFetch(url('site.test', '/hang'), { ...options, timeoutMs: 100 })).rejects.toThrow(
            /no response within 100 ms/,
        );
        const tool = createWebFetchTool(options);
        await expect(tool.execute({ url: url('site.test', '/image') }, ctx)).rejects.toThrow(
            /unsupported content type: image\/png/,
        );
        await expect(tool.execute({ url: url('site.test', '/missing') }, ctx)).rejects.toThrow(/HTTP 404/);
        await expect(tool.execute({ url: 'x', extra: 1 }, ctx)).rejects.toThrow();
    });

    it('默认需审批;只能按域名预授权', () => {
        const tool = createWebFetchTool(options);
        expect(tool).toMatchObject({ risk: 'read', approval: 'required', untrustedOutput: true });
        expect(checkRemember(tool, { scope: 'always' })).toMatch(/only be pre-authorized with a domain constraint/);
        expect(checkRemember(tool, { scope: 'always', constraint: { domain: 'example.com' } })).toBeNull();
        expect(tool.constraints?.domain?.({ url: 'https://Docs.Example.com/a' }, ctx)).toBe('docs.example.com');
        expect(tool.constraints?.domain?.({ url: 'file:///x' }, ctx)).toBeNull();
        expect(tool.constraints?.domain?.({ url: 'bad' }, ctx)).toBeNull();
        expect(tool.constraints?.domain?.(null, ctx)).toBeNull();
        expect(tool.summarize({ url: 'https://example.com' })).toBe('Fetch https://example.com');
    });
});

describe('htmlToText', () => {
    it('没有标题时 title 为 null;未知实体原样保留', () => {
        expect(htmlToText('<p>a &unknown; b</p>')).toEqual({ title: null, text: 'a &unknown; b' });
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

describe('内容安全策略(ADR 0046 第 3.4 节)', () => {
    it('每个响应都带 CSP:只允许同源脚本、不允许插件和被嵌入,连接只到同源', async () => {
        s = await createTestServer();
        const res = await s.app.request('/healthz');
        const csp = res.headers.get('content-security-policy') ?? '';
        const directive = (name: string) =>
            csp
                .split(';')
                .find((d) => d.trim().startsWith(`${name} `))
                ?.trim();
        expect(directive('default-src')).toBe("default-src 'self'");
        expect(directive('script-src')).toBe("script-src 'self'");
        expect(directive('connect-src')).toBe("connect-src 'self'");
        expect(directive('object-src')).toBe("object-src 'none'");
        expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
        // 脚本里不允许 unsafe-inline / unsafe-eval,也不放行任何外部来源
        expect(directive('script-src')).not.toMatch(/unsafe|https?:|\*/);
        expect(directive('img-src')).not.toMatch(/https?:|\*/);
    });
});

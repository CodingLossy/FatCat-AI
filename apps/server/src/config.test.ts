// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hashPassword, safeEqual, verifyPassword } from './auth/crypto.js';
import { FailureLimiter } from './auth/rate-limit.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';

describe('loadConfig', () => {
    it('默认只监听本机,数据目录在用户目录下', () => {
        expect(loadConfig({})).toEqual({
            host: '127.0.0.1',
            port: 8787,
            sourceUrl: 'https://github.com/CodingLossy/AI-Personal',
            webDir: null,
            dataDir: join(homedir(), '.ai-personal'),
            cookieSecure: 'auto',
            setupCode: null,
            logLevel: 'info',
        });
    });

    it('可用环境变量覆盖', () => {
        const c = loadConfig({
            AIP_SOURCE_URL: 'https://example.com/fork',
            AIP_DATA_DIR: '/data',
            AIP_COOKIE_SECURE: 'always',
            AIP_SETUP_CODE: 'abcdefgh',
        });
        expect(c).toMatchObject({
            sourceUrl: 'https://example.com/fork',
            dataDir: '/data',
            cookieSecure: 'always',
            setupCode: 'abcdefgh',
        });
    });

    it('拒绝非法取值', () => {
        expect(() => loadConfig({ AIP_PORT: '70000' })).toThrow();
        expect(() => loadConfig({ AIP_COOKIE_SECURE: 'maybe' })).toThrow();
        expect(() => loadConfig({ AIP_SETUP_CODE: 'short' })).toThrow();
    });
});

describe('密码哈希', () => {
    it('scrypt 哈希可校验,错误密码与损坏的哈希返回 false', async () => {
        const hash = await hashPassword('correct horse battery staple');
        expect(hash).toMatch(/^scrypt\$65536\$8\$1\$/);
        expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
        expect(await verifyPassword('wrong', hash)).toBe(false);
        expect(await verifyPassword('x', 'garbage')).toBe(false);
        expect(hash).not.toBe(await hashPassword('correct horse battery staple')); // 每次加盐不同
    });

    it('safeEqual 比较长度不同的字符串不抛错', () => {
        expect(safeEqual('a', 'ab')).toBe(false);
        expect(safeEqual('ab', 'ab')).toBe(true);
    });
});

describe('FailureLimiter', () => {
    it('窗口内超过上限后限制,窗口结束后恢复', () => {
        let t = 0;
        const limiter = new FailureLimiter(2, 1000, () => t);
        limiter.recordFailure('a');
        expect(limiter.retryAfter('a')).toBe(0);
        limiter.recordFailure('a');
        expect(limiter.retryAfter('a')).toBe(1);
        t = 1001;
        expect(limiter.retryAfter('a')).toBe(0);
    });
});

describe('日志', () => {
    it('输出 JSON 行,并屏蔽凭据字段', () => {
        const lines: string[] = [];
        const destination = new Writable({
            write(chunk: Buffer, _e, cb) {
                lines.push(chunk.toString());
                cb();
            },
        });
        const logger = createLogger({ destination });
        logger.info({ password: 'p@ss', nested: { token: 't0k', authorization: 'Bearer x' }, port: 1 }, 'hello');
        const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(entry).toMatchObject({ level: 'info', msg: 'hello', port: 1, password: '[REDACTED]' });
        expect(typeof entry.time).toBe('string');
        expect(lines[0]).not.toMatch(/p@ss|t0k|Bearer x/);
    });
});

describe('日志按值脱敏', () => {
    it('redactLine 在每行写出前执行', () => {
        const lines: string[] = [];
        const destination = new Writable({
            write(chunk: Buffer, _e, cb) {
                lines.push(chunk.toString());
                cb();
            },
        });
        const logger = createLogger({ destination, redactLine: (l) => l.split('secret-value-123').join('[REDACTED]') });
        logger.info({ note: 'the key is secret-value-123' }, 'x');
        expect(lines[0]).toContain('[REDACTED]');
        expect(lines[0]).not.toContain('secret-value-123');
    });
});

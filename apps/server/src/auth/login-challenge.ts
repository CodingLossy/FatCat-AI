// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { randomToken, sha256 } from './crypto.js';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** 同一个临时凭证最多允许的验证失败次数;达到后作废,需要重新输入密码。 */
export const CHALLENGE_MAX_FAILURES = 5;
/** 同时存在的临时凭证上限,防止被大量登录请求撑大内存。 */
const MAX_PENDING = 200;

interface Entry {
    ownerId: string;
    expiresAt: number;
    failures: number;
}

/**
 * 密码通过、等待第二因素时发出的临时凭证(ADR 0027 第 2 节)。
 * 只在内存里保存凭证的 SHA-256;5 分钟有效,一次性,失败 5 次作废,进程重启即失效。
 * 它不是会话:不会被鉴权中间件认作 Cookie、CSRF 令牌或个人访问令牌。
 */
export class LoginChallenges {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly now: () => Date = () => new Date()) {}

    issue(ownerId: string): { token: string; expiresAt: Date } {
        const t = this.now().getTime();
        for (const [key, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(key);
        while (this.entries.size >= MAX_PENDING) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        const token = randomToken();
        const expiresAt = t + CHALLENGE_TTL_MS;
        this.entries.set(sha256(token), { ownerId, expiresAt, failures: 0 });
        return { token, expiresAt: new Date(expiresAt) };
    }

    /** 有效(存在、未过期)时返回所属用户,否则 null(过期的顺便清掉)。 */
    lookup(token: string): { ownerId: string } | null {
        const key = sha256(token);
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= this.now().getTime()) {
            this.entries.delete(key);
            return null;
        }
        return { ownerId: entry.ownerId };
    }

    /** 记一次失败;达到上限即作废。 */
    fail(token: string): void {
        const key = sha256(token);
        const entry = this.entries.get(key);
        if (!entry) return;
        entry.failures++;
        if (entry.failures >= CHALLENGE_MAX_FAILURES) this.entries.delete(key);
    }

    /** 一次性:成功使用后删除。 */
    consume(token: string): void {
        this.entries.delete(sha256(token));
    }
}

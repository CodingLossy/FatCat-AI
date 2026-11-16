// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/**
 * 登录失败限速:同一来源在窗口期内失败达到上限后拒绝,直到窗口结束(ADR 0004 第 2 节)。
 * 只在内存中计数;单进程核心,重启后清零可以接受。
 */
export class FailureLimiter {
    private readonly failures = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly maxFailures: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** 被限制时返回需要等待的秒数,否则返回 0。 */
    retryAfter(key: string): number {
        const entry = this.failures.get(key);
        if (!entry) return 0;
        const left = entry.resetAt - this.now();
        if (left <= 0) {
            this.failures.delete(key);
            return 0;
        }
        return entry.count >= this.maxFailures ? Math.ceil(left / 1000) : 0;
    }

    recordFailure(key: string): number {
        const t = this.now();
        const entry = this.failures.get(key);
        if (!entry || entry.resetAt <= t) {
            this.failures.set(key, { count: 1, resetAt: t + this.windowMs });
        } else {
            entry.count++;
        }
        // 防止被大量来源撑大内存:超过上限时清理过期项
        if (this.failures.size > 10_000) {
            for (const [k, v] of this.failures) if (v.resetAt <= t) this.failures.delete(k);
        }
        return 0;
    }

    reset(key: string): void {
        this.failures.delete(key);
    }
}

/** 登录与第二因素共用的限流接口。 */
export interface AttemptLimiter {
    /** 被限制时返回需要等待的秒数,否则返回 0。 */
    retryAfter(key: string): number;
    /** 返回这次失败新触发的锁定秒数;没有触发新锁定时为 0。 */
    recordFailure(key: string): number;
    reset(key: string): void;
}

/** 第二因素限流:每连续失败满 LOCK_EVERY 次锁定一次,时长逐级加长。 */
export const TOTP_LOCK_EVERY = 10;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 累计失败的统计窗口;最后一次失败之后超过它(且已不在锁定中)就清零。 */
export const TOTP_FAILURE_WINDOW_MS = 24 * HOUR;

/**
 * 第 level 次锁定的时长:1 级 15 分钟,2 级 1 小时,之后每级翻倍,最长 24 小时。
 */
export function escalatedLockMs(level: number): number {
    if (level <= 1) return 15 * MINUTE;
    return Math.min(TOTP_FAILURE_WINDOW_MS, HOUR * 2 ** (level - 2));
}

/**
 * 逐级加长锁定的失败计数(ADR 0027 第 3 节):按键累计失败,不是固定窗口。
 * 累计 10 次锁 15 分钟,20 次锁 1 小时,30 次 2 小时,之后每 10 次翻倍,上限 24 小时;
 * 只有 reset(成功验证)才清零,或距最后一次失败超过 24 小时且不在锁定中。
 * 持有密码的人每天最多能猜约 30 次(而不是固定窗口下的 7200 次)。只在内存中计数。
 */
export class EscalatingLimiter implements AttemptLimiter {
    private readonly entries = new Map<string, { count: number; lastAt: number; lockedUntil: number }>();

    constructor(
        private readonly now: () => number = Date.now,
    ) {}

    retryAfter(key: string): number {
        const entry = this.entries.get(key);
        if (!entry) return 0;
        const t = this.now();
        if (entry.lockedUntil > t) return Math.ceil((entry.lockedUntil - t) / 1000);
        if (t - entry.lastAt > TOTP_FAILURE_WINDOW_MS) this.entries.delete(key);
        return 0;
    }

    recordFailure(key: string): number {
        const t = this.now();
        let entry = this.entries.get(key);
        if (entry && entry.lockedUntil <= t && t - entry.lastAt > TOTP_FAILURE_WINDOW_MS) entry = undefined;
        if (!entry) {
            entry = { count: 0, lastAt: t, lockedUntil: 0 };
            this.entries.set(key, entry);
        }
        entry.count++;
        entry.lastAt = t;
        let locked = 0;
        if (entry.count % TOTP_LOCK_EVERY === 0) {
            const ms = escalatedLockMs(entry.count / TOTP_LOCK_EVERY);
            entry.lockedUntil = Math.max(entry.lockedUntil, t + ms);
            locked = Math.ceil(ms / 1000);
        }
        if (this.entries.size > 10_000) {
            for (const [k, v] of this.entries) {
                if (v.lockedUntil <= t && t - v.lastAt > TOTP_FAILURE_WINDOW_MS) this.entries.delete(k);
            }
        }
        return locked;
    }

    reset(key: string): void {
        this.entries.delete(key);
    }
}

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

    recordFailure(key: string): void {
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
    }

    reset(key: string): void {
        this.failures.delete(key);
    }
}

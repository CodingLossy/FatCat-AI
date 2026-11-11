// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/**
 * 固定窗口计数限流(ADR 0021 第 5 节):每个键在窗口内最多 max 次。只在内存中计数,重启清零。
 */
export class WindowLimiter {
    private readonly windows = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** 记一次;允许时返回 0,超限时返回需要等待的秒数(不计入本次)。 */
    take(key: string): number {
        const t = this.now();
        const entry = this.windows.get(key);
        if (!entry || entry.resetAt <= t) {
            this.windows.set(key, { count: 1, resetAt: t + this.windowMs });
            if (this.windows.size > 1000) {
                for (const [k, v] of this.windows) if (v.resetAt <= t) this.windows.delete(k);
            }
            return 0;
        }
        if (entry.count >= this.max) return Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
        entry.count++;
        return 0;
    }
}

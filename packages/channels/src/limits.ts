// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/** 滑动窗口计数:窗口内最多 limit 次(ADR 0022 第 4 节的每分钟 20 条)。 */
export class SlidingWindow {
    private readonly hits: number[] = [];

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** 记一次;超出上限时返回 false(不计入)。 */
    take(): boolean {
        const t = this.now();
        while (this.hits.length > 0 && this.hits[0]! <= t - this.windowMs) this.hits.shift();
        if (this.hits.length >= this.limit) return false;
        this.hits.push(t);
        return true;
    }

    /** 窗口内的次数。 */
    count(): number {
        const t = this.now();
        return this.hits.filter((h) => h > t - this.windowMs).length;
    }

    clear(): void {
        this.hits.length = 0;
    }
}

export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** 第 attempt 次重启(从 0 起)前的等待:1 s 起翻倍,最长 5 分钟,±20% 抖动(ADR 0022 第 8 节)。 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(BACKOFF_START_MS * 2 ** Math.min(attempt, 30), BACKOFF_MAX_MS);
    return Math.round(base * (0.8 + 0.4 * random()));
}

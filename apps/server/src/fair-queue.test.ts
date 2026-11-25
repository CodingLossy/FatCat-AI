// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { FairQueue } from './fair-queue.js';

describe('按账户轮转的后台队列(ADR 0053 第 8 节)', () => {
    it('一个账户先排进一大批,另一个账户后来的任务也轮流运行;失败不影响后面的任务', async () => {
        const queue = new FairQueue(1);
        const order: string[] = [];
        const job =
            (name: string, fail = false) =>
            () =>
                new Promise<string>((resolve, reject) =>
                    setTimeout(() => {
                        order.push(name);
                        if (fail) reject(new Error(name));
                        else resolve(name);
                    }, 1),
                );
        const all = [
            ...['a1', 'a2', 'a3', 'a4'].map((n) => queue.run('a', job(n, n === 'a2'))),
            queue.run('b', job('b1')),
            queue.run('b', job('b2')),
        ];
        const results = await Promise.allSettled(all);
        expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'a4']);
        expect(results[1]).toMatchObject({ status: 'rejected' });
        expect(results[5]).toEqual({ status: 'fulfilled', value: 'b2' });
        expect(queue.size).toBe(0);
    });

    it('并发上限:同时运行的任务不超过设定值', async () => {
        const queue = new FairQueue(2);
        let active = 0;
        let peak = 0;
        const job = () =>
            new Promise<void>((resolve) => {
                active++;
                peak = Math.max(peak, active);
                setTimeout(() => {
                    active--;
                    resolve();
                }, 1);
            });
        await Promise.all(['a', 'a', 'b', 'c', 'c'].map((o) => queue.run(o, job)));
        expect(peak).toBe(2);
    });
});

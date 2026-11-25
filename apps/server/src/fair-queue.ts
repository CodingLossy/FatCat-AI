// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 按账户轮转的后台任务队列(ADR 0053 第 8 节):同时运行的任务数有上限;有空位时,
// 正在运行的任务最少、最久没轮到的账户先走,同一账户内按排队先后。一个账户一次排进一大批任务,
// 别的账户后来的任务也不用等它们全部做完。

interface Job {
    ownerId: string;
    start: () => void;
}

export class FairQueue {
    private readonly waiting: Job[] = [];
    private readonly running = new Map<string, number>();
    private readonly lastStarted = new Map<string, number>();
    private active = 0;
    private seq = 0;

    constructor(private readonly concurrency = 1) {}

    /** 排队运行一个任务;返回任务本身的结果。 */
    run<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({
                ownerId,
                start: () => {
                    task()
                        .then(resolve, reject)
                        .finally(() => {
                            this.active--;
                            this.running.set(ownerId, (this.running.get(ownerId) ?? 1) - 1);
                            this.pump();
                        });
                },
            });
            this.pump();
        });
    }

    /** 排队中(还没开始)的任务数。 */
    get size(): number {
        return this.waiting.length;
    }

    private pump(): void {
        while (this.active < this.concurrency && this.waiting.length > 0) {
            let best = 0;
            let bestKey: [number, number] = [Infinity, Infinity];
            for (const [i, job] of this.waiting.entries()) {
                const key: [number, number] = [
                    this.running.get(job.ownerId) ?? 0,
                    this.lastStarted.get(job.ownerId) ?? -1,
                ];
                if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
                    best = i;
                    bestKey = key;
                }
            }
            const [job] = this.waiting.splice(best, 1);
            this.active++;
            this.running.set(job!.ownerId, (this.running.get(job!.ownerId) ?? 0) + 1);
            this.lastStarted.set(job!.ownerId, ++this.seq);
            job!.start();
        }
    }
}

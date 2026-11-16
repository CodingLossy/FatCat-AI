// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道内存预算的判定(ADR 0018 第 2 节规则 3、4、5 与第 5 节):纯函数,压测脚本和测试共用。
export const ROLLBACK_LIMIT_MIB = 60;
export const CREEP_LIMIT_MIB = 5;
/** 规则 4 的累计检查:从第 2 次起每次都至少涨 STEP_MIB,且最后一次比第 2 次多出超过 SUSTAINED_LIMIT_MIB。 */
export const SUSTAINED_STEP_MIB = 2;
export const SUSTAINED_LIMIT_MIB = 6;

const round1 = (n) => Math.round(n * 10) / 10;

/** 增量上限 = 实测增量 × 1.5,向上取整到 5 MiB(至少 5)。 */
export function capFromMeasured(measuredMiB) {
    return Math.max(5, Math.ceil((Math.max(0, measuredMiB) * 1.5) / 5) * 5);
}

/**
 * 规则 4(不持续上涨):settled 是每次负载后空闲 60 秒的 RSS,按运行顺序;少于 3 次不判定。
 * ① 最后一次与此前各次的最高值比较,避免单次 GC 回落造成误报(堆在头几次负载里会一次性长一档,之后基本不再涨);
 * ② 连跑 ≥ 4 次时累计检查:从第 2 次起每次都至少涨 SUSTAINED_STEP_MIB,且最后一次比第 2 次多出超过 SUSTAINED_LIMIT_MIB。
 * @param {number[]} settled
 * @returns {string[]}
 */
export function evaluateCreep(settled) {
    const errors = [];
    if (settled.length < 3) return errors;
    const n = settled.length;
    const prevPeak = Math.max(...settled.slice(0, -1));
    const creep = round1(settled[n - 1] - prevPeak);
    if (creep > CREEP_LIMIT_MIB)
        errors.push(
            `run ${n} is ${creep} MiB above the highest earlier run (limit ${CREEP_LIMIT_MIB}, ADR 0018 rule 4)`,
        );
    // 每次只涨 4 MiB 的慢泄漏(120/124/128/132)单次比较永远不超 5 MiB,要看从第 2 次起是否一直在涨
    if (n >= 4) {
        const tail = settled.slice(1);
        const steps = tail.slice(1).map((v, i) => round1(v - tail[i]));
        const total = round1(settled[n - 1] - settled[1]);
        if (steps.every((d) => d >= SUSTAINED_STEP_MIB) && total > SUSTAINED_LIMIT_MIB)
            errors.push(
                `every run since run 2 grew by at least ${SUSTAINED_STEP_MIB} MiB and run ${n} is ${total} MiB above run 2 (limit ${SUSTAINED_LIMIT_MIB}, ADR 0018 rule 4)`,
            );
    }
    return errors;
}

/**
 * @param {{ idleWithout: number, idleWith: number, settled: number[], incrementCap: number }} input
 *   idleWithout:不配置渠道的空闲 RSS;idleWith:配置并绑定该渠道后的空闲 RSS;
 *   settled:每次负载后空闲 60 秒的 RSS(按运行顺序);incrementCap:该渠道的增量上限
 * @returns {{ increment: number, errors: string[] }}
 */
export function evaluateChannel({ idleWithout, idleWith, settled, incrementCap }) {
    const increment = round1(idleWith - idleWithout);
    const errors = [];
    if (increment > incrementCap)
        errors.push(`channel increment ${increment} MiB is over its ${incrementCap} MiB cap (ADR 0018 rule 5)`);
    settled.forEach((rss, i) => {
        const delta = round1(rss - idleWith);
        if (delta > ROLLBACK_LIMIT_MIB)
            errors.push(
                `run ${i + 1}: ${delta} MiB above the channel's idle after settling (limit ${ROLLBACK_LIMIT_MIB}, ADR 0018 rule 3)`,
            );
    });
    errors.push(...evaluateCreep(settled));
    return { increment, errors };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道内存预算的判定(ADR 0018 第 2 节规则 3、4、5 与第 5 节):纯函数,压测脚本和测试共用。
export const ROLLBACK_LIMIT_MIB = 60;
export const CREEP_LIMIT_MIB = 5;

const round1 = (n) => Math.round(n * 10) / 10;

/** 增量上限 = 实测增量 × 1.5,向上取整到 5 MiB(至少 5)。 */
export function capFromMeasured(measuredMiB) {
    return Math.max(5, Math.ceil((Math.max(0, measuredMiB) * 1.5) / 5) * 5);
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
    if (settled.length >= 3) {
        // 比最后两次:渠道的堆会在头几次负载里一次性长一档(实测第 3 次曾多 7 MiB,之后每次 < 0.5 MiB)
        const n = settled.length;
        const creep = round1(settled[n - 1] - settled[n - 2]);
        if (creep > CREEP_LIMIT_MIB)
            errors.push(`run ${n} is ${creep} MiB above run ${n - 1} (limit ${CREEP_LIMIT_MIB}, ADR 0018 rule 4)`);
    }
    return { increment, errors };
}

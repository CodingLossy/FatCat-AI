// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 空闲内存预算检查(ADR 0018 第 2 节规则 1、2):参数是若干次 VmRSS 采样(KiB),取中位数,
// 与 250 MiB 上限和 .github/memory-baseline.json 的基线比较。> 10% 报警,> 20% 或超过上限失败。
//
//   node scripts/perf/idle-budget.mjs 113000 113400 112900
import { appendFileSync, readFileSync } from 'node:fs';

const CAP_MIB = 250;
const WARN_RATIO = 1.1;
const FAIL_RATIO = 1.2;

const samples = process.argv.slice(2).map(Number);
if (samples.length === 0 || samples.some((n) => !Number.isFinite(n) || n <= 0)) {
    console.error('usage: idle-budget.mjs <VmRSS KiB> [<VmRSS KiB> ...]');
    process.exit(2);
}
const sorted = [...samples].sort((a, b) => a - b);
const rss = Math.round((sorted[Math.floor(sorted.length / 2)] / 1024) * 10) / 10;
const { idleRssMiB: baseline } = JSON.parse(
    readFileSync(new URL('../../.github/memory-baseline.json', import.meta.url)),
);
const growth = Math.round((rss / baseline - 1) * 1000) / 10;
const line = `Idle RSS ${rss} MiB (median of ${samples.length}); baseline ${baseline} MiB (${growth >= 0 ? '+' : ''}${growth}%); cap ${CAP_MIB} MiB`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);

let failed = false;
if (rss > CAP_MIB) {
    console.log(`::error::Idle RSS ${rss} MiB is over the ${CAP_MIB} MiB cap (ADR 0018 rule 1).`);
    failed = true;
}
if (rss > baseline * FAIL_RATIO) {
    console.log(
        `::error::Idle RSS grew ${growth}% over the baseline (more than 20%, ADR 0018 rule 2). If this is intended, update .github/memory-baseline.json in this PR and give the reason in the PR description.`,
    );
    failed = true;
} else if (rss > baseline * WARN_RATIO) {
    console.log(`::warning::Idle RSS grew ${growth}% over the baseline (more than 10%, ADR 0018 rule 2).`);
}
process.exit(failed ? 1 : 0);

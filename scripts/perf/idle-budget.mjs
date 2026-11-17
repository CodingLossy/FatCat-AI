// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 空闲内存报告(ADR 0041,取代 ADR 0018 的门禁):参数是若干次 VmRSS 采样(KiB),取中位数,
// 与 .github/memory-baseline.json 记录的参考值比较,把结果打印并写进 job summary。只报告,永远不让 CI 失败
// (参数错误除外,退出码 2)。
//
//   node scripts/perf/idle-budget.mjs 113000 113400 112900
import { appendFileSync, readFileSync } from 'node:fs';

const NOTE_RATIO = 1.1;

const samples = process.argv.slice(2).map(Number);
if (samples.length === 0 || samples.some((n) => !Number.isFinite(n) || n <= 0)) {
    console.error('usage: idle-budget.mjs <VmRSS KiB> [<VmRSS KiB> ...]');
    process.exit(2);
}
const sorted = [...samples].sort((a, b) => a - b);
const rss = Math.round((sorted[Math.floor(sorted.length / 2)] / 1024) * 10) / 10;
const { idleRssMiB: reference } = JSON.parse(
    readFileSync(new URL('../../.github/memory-baseline.json', import.meta.url)),
);
const growth = Math.round((rss / reference - 1) * 1000) / 10;
const line = `Idle RSS ${rss} MiB (median of ${samples.length}); reference ${reference} MiB (${growth >= 0 ? '+' : ''}${growth}%); report only, not a gate`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Idle memory\n\n${line}\n`);
if (rss > reference * NOTE_RATIO) {
    console.log(
        `::notice::Idle RSS is ${growth}% above the recorded reference. Memory is measured, not gated (ADR 0041); mention the reason in the PR if the growth is intended.`,
    );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆评测的运行器:每个用例一个临时数据库,按用例写入、抽取(回放录制的模型输出),再检查期望。
// 指标:
// - 召回率:期望出现在检索前 3 条中的比例(召回、更替与按查询检查可信度的用例);
// - 过时率:应当已被更替的旧值仍出现在检索前 3 条中的比例(带 notExpected 的用例);
// - 错误率:没有通过的用例所占比例。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDigestBuilder, createExtractor, createMemoryService, createRetriever } from '@ai-personal/memory';
import { createRepositories, openStorage } from '@ai-personal/storage';
import { type MemoryCase, MEMORY_CASES } from './cases.js';

const NOW = new Date('2026-11-05T00:00:00Z');
const DAY = 86_400_000;
const TOP = 3;

export interface CaseResult {
    id: string;
    category: MemoryCase['category'];
    pass: boolean;
    detail: string;
}

export interface MemoryEvalReport {
    total: number;
    passed: number;
    recall: number;
    staleRate: number;
    errorRate: number;
    results: CaseResult[];
}

async function runCase(c: MemoryCase): Promise<CaseResult & { recallHit?: boolean; staleHit?: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), 'aip-memory-eval-'));
    const { conn } = await openStorage({ dataDir: dir });
    try {
        let clock = NOW;
        const repos = createRepositories(conn, { now: () => clock });
        const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
        repos.settings.update(ownerId, { memory: { autoExtract: true } });
        const memory = createMemoryService(repos);

        for (const w of c.writes ?? []) {
            clock = new Date(NOW.getTime() - (w.ageDays ?? 0) * DAY);
            memory.write(
                ownerId,
                {
                    text: w.text,
                    ...(w.entityKey ? { entityKey: w.entityKey } : {}),
                    ...(w.memType ? { memType: w.memType } : {}),
                },
                { origin: w.origin ?? 'user_explicit', ...(w.untrusted ? { untrusted: true } : {}) },
            );
        }
        clock = NOW;
        for (const x of c.extracts ?? []) {
            const session = repos.sessions.create(ownerId);
            const user = repos.messages.append(ownerId, session.id, {
                role: 'user',
                parts: [{ type: 'text', text: x.user }],
                status: 'complete',
            });
            const answer = repos.messages.append(ownerId, session.id, {
                role: 'assistant',
                parts: [{ type: 'text', text: x.answer }],
                status: 'complete',
            });
            // 回放:录制的 cheap 模型输出
            const extractor = createExtractor({ repos, memory, complete: () => Promise.resolve(x.recorded) });
            await extractor.extract({
                ownerId,
                sessionId: session.id,
                userMessageId: user.id,
                assistantMessageId: answer.id,
                untrustedContentSeen: x.untrusted ?? false,
            });
        }

        const retriever = createRetriever({ repos, now: () => NOW, flushMs: 60_000 });
        const e = c.expect;
        if (e.kind === 'recall') {
            const top = (await retriever.retrieve(ownerId, { query: e.query })).items.slice(0, TOP).map((i) => i.text);
            const recallHit = top.includes(e.expected);
            const staleHit = e.notExpected ? top.includes(e.notExpected) : undefined;
            return {
                id: c.id,
                category: c.category,
                pass: recallHit && !staleHit,
                detail: `top: ${JSON.stringify(top)}`,
                recallHit,
                ...(staleHit !== undefined ? { staleHit } : {}),
            };
        }
        if (e.kind === 'qualifier') {
            const first = (await retriever.retrieve(ownerId, { query: e.query })).items[0];
            return {
                id: c.id,
                category: c.category,
                pass: first?.qualifier === e.qualifier,
                detail: `first: ${first ? `${first.text} (${first.qualifier})` : 'none'}`,
                recallHit: first !== undefined,
            };
        }
        if (e.kind === 'conflict') {
            const digest = createDigestBuilder({ repos, now: () => NOW }).build(ownerId);
            const pass = repos.memories.conflicts(ownerId).length === 1 && digest.body.includes('待向用户确认');
            return { id: c.id, category: c.category, pass, detail: `open conflicts: ${digest.openConflicts}` };
        }
        const stored = repos.memories.list(ownerId, 100).map((m) => m.text);
        const leaked = stored.filter((t) => t.includes(e.forbidden));
        return {
            id: c.id,
            category: c.category,
            pass: leaked.length === 0,
            detail: `stored: ${JSON.stringify(stored)}`,
        };
    } finally {
        conn.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

export async function runMemoryEval(cases: readonly MemoryCase[] = MEMORY_CASES): Promise<MemoryEvalReport> {
    const results = [];
    for (const c of cases) results.push(await runCase(c));
    const recallCases = results.filter((r) => r.recallHit !== undefined);
    const staleCases = results.filter((r) => r.staleHit !== undefined);
    const passed = results.filter((r) => r.pass).length;
    const ratio = (n: number, d: number) => (d === 0 ? 0 : Number((n / d).toFixed(4)));
    return {
        total: results.length,
        passed,
        recall: ratio(recallCases.filter((r) => r.recallHit).length, recallCases.length),
        staleRate: ratio(staleCases.filter((r) => r.staleHit).length, staleCases.length),
        errorRate: ratio(results.length - passed, results.length),
        results: results.map(({ id, category, pass, detail }) => ({ id, category, pass, detail })),
    };
}

/** 评测报告的文本形式(`pnpm eval` 输出)。 */
export function formatReport(report: MemoryEvalReport): string {
    const lines = [
        `记忆评测:${report.passed}/${report.total} 通过`,
        `召回率 ${(report.recall * 100).toFixed(1)}% · 过时率 ${(report.staleRate * 100).toFixed(1)}% · 错误率 ${(report.errorRate * 100).toFixed(1)}%`,
        '',
    ];
    for (const r of report.results)
        lines.push(`${r.pass ? '✓' : '✗'} [${r.category}] ${r.id}${r.pass ? '' : ` — ${r.detail}`}`);
    return lines.join('\n');
}

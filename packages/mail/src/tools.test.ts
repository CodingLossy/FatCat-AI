// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { DEFAULT_SETTINGS } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import type { ToolContext } from '@fatcat-ai/tools';
import { describe, expect, it } from 'vitest';
import { createMailTools } from './tools.js';

const ctx: ToolContext = {
    ownerId: 'owner',
    sessionId: 's',
    runId: 'r',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
};

/** 只实现 mail.list 用到的两个仓储:记下查询的 since。 */
function fakeRepos(timeZone: string | null) {
    const since: (string | undefined)[] = [];
    const repos = {
        settings: { get: () => ({ ...DEFAULT_SETTINGS, timeZone }) },
        mailCache: {
            list: (_ownerId: string, query: { since?: string }) => {
                since.push(query.since);
                return [];
            },
        },
    } as unknown as Repositories;
    return { repos, since };
}

function listTool(repos: Repositories, extra: { timeZone?: string } = {}) {
    const tools = createMailTools({
        repos,
        runner: { run: () => Promise.reject(new Error('unused')) } as never,
        secret: () => null,
        roots: () => [],
        complete: () => Promise.resolve(''),
        now: () => new Date('2026-11-10T17:00:00Z'), // 上海已是 11 日 01:00
        ...extra,
    });
    return tools.find((t) => t.name === 'mail.list')!;
}

describe('mail.list 的「今天」按用户时区(ADR 0023 第 6 节)', () => {
    it('用户时区 Asia/Shanghai:今天从 11 日 00:00(上海)算起', async () => {
        const { repos, since } = fakeRepos('Asia/Shanghai');
        await listTool(repos).execute({ today: true }, ctx);
        expect(since).toEqual(['2026-11-10T16:00:00.000Z']);
    });

    it('用户时区 UTC:今天仍是 10 日', async () => {
        const { repos, since } = fakeRepos('UTC');
        await listTool(repos).execute({ today: true }, ctx);
        expect(since).toEqual(['2026-11-10T00:00:00.000Z']);
    });

    it('显式传入的 timeZone 优先(测试与旧调用方)', async () => {
        const { repos, since } = fakeRepos('Asia/Shanghai');
        await listTool(repos, { timeZone: 'UTC' }).execute({ today: true }, ctx);
        expect(since).toEqual(['2026-11-10T00:00:00.000Z']);
    });
});

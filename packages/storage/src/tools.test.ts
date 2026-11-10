// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
let sessionId: string;
let runId: string;
beforeEach(async () => {
    t = await createTestDb({ now: fakeClock().auto() });
    sessionId = t.repos.sessions.create(t.ownerId).id;
    const user = t.repos.messages.append(t.ownerId, sessionId, {
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        status: 'complete',
    });
    runId = t.repos.runs.create(t.ownerId, { sessionId, inputMessageId: user.id }).id;
});
afterEach(() => t.cleanup());

const request = (callId: string) => ({
    callId,
    runId,
    sessionId,
    toolName: 'fs.write',
    risk: 'write' as const,
    summary: 'Write notes.md',
    input: { path: 'notes.md' },
    preauthorizable: true,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
});

describe('approvals', () => {
    it('只有第一个决定生效;重启时 pending 一律过期;分页按时间倒序', () => {
        const { approvals } = t.repos;
        approvals.create(t.ownerId, request('c1'));
        approvals.create(t.ownerId, request('c2'));
        approvals.create(t.ownerId, request('c3'));

        expect(approvals.decide(t.ownerId, 'c1', 'approved')).toBe(true);
        expect(approvals.decide(t.ownerId, 'c1', 'rejected')).toBe(false);
        expect(approvals.get(t.ownerId, 'c1')).toMatchObject({ status: 'approved', input: { path: 'notes.md' } });
        expect(approvals.decide('someone-else', 'c2', 'approved')).toBe(false);

        const first = approvals.list(t.ownerId, { limit: 1, status: 'pending' });
        expect(first.items.map((a) => a.callId)).toEqual(['c3']);
        const second = approvals.list(t.ownerId, { limit: 5, status: 'pending', cursor: first.nextCursor! });
        expect(second).toEqual({ items: [expect.objectContaining({ callId: 'c2' })], nextCursor: null });

        expect(approvals.expireAllPending()).toBe(2);
        expect(approvals.list(t.ownerId, { limit: 10, status: 'pending' }).items).toEqual([]);
        expect(approvals.list(t.ownerId, { limit: 10 }).items.map((a) => a.status)).toEqual([
            'expired',
            'expired',
            'approved',
        ]);
    });

    it('删除会话时级联删除审批请求与本会话的预授权,永久预授权保留', () => {
        t.repos.approvals.create(t.ownerId, request('c1'));
        const forSession = t.repos.preauths.create(t.ownerId, {
            toolName: 'fs.write',
            scope: 'session',
            sessionId,
            constraint: { pathPrefix: '/docs' },
        });
        const always = t.repos.preauths.create(t.ownerId, {
            toolName: 'fs.write',
            scope: 'always',
            sessionId,
            constraint: null,
        });
        expect(always.sessionId).toBeNull();
        expect(t.repos.preauths.forTool(t.ownerId, 'fs.write', sessionId).map((p) => p.id)).toEqual([
            forSession.id,
            always.id,
        ]);
        expect(t.repos.preauths.forTool(t.ownerId, 'fs.write', newId()).map((p) => p.id)).toEqual([always.id]);

        t.repos.sessions.delete(t.ownerId, sessionId);
        expect(t.repos.approvals.get(t.ownerId, 'c1')).toBeNull();
        expect(t.repos.preauths.list(t.ownerId).map((p) => p.id)).toEqual([always.id]);

        t.repos.preauths.touch(always.id);
        expect(t.repos.preauths.get(t.ownerId, always.id)?.lastUsedAt).not.toBeNull();
        expect(t.repos.preauths.delete('someone-else', always.id)).toBe(false);
        expect(t.repos.preauths.delete(t.ownerId, always.id)).toBe(true);
    });
});

describe('audit', () => {
    const entry = (toolName: string, risk: 'write' | 'external') => ({
        action: 'tool-call' as const,
        toolName,
        risk,
        callId: null,
        runId: null,
        sessionId: null,
        decision: 'approved' as const,
        outcome: 'ok' as const,
        summary: toolName,
        inputDigest: '{}',
        error: null,
    });

    it('按时间倒序分页,可按工具与风险过滤;会话删除后仍保留;可按时间清理', () => {
        const { audit } = t.repos;
        const a = audit.append(t.ownerId, { ...entry('fs.write', 'write'), sessionId });
        audit.append(t.ownerId, entry('mail.send', 'external'));
        const c = audit.append(t.ownerId, entry('fs.write', 'write'));

        const page = audit.list(t.ownerId, { limit: 1, toolName: 'fs.write' });
        expect(page.items.map((x) => x.id)).toEqual([c.id]);
        expect(audit.list(t.ownerId, { limit: 5, toolName: 'fs.write', cursor: page.nextCursor! }).items).toEqual([a]);
        expect(audit.list(t.ownerId, { limit: 5, risk: 'external' }).items.map((x) => x.toolName)).toEqual([
            'mail.send',
        ]);
        expect(audit.list(t.ownerId, { limit: 5, since: c.at }).items.map((x) => x.id)).toEqual([c.id]);

        t.repos.sessions.delete(t.ownerId, sessionId);
        expect(audit.list(t.ownerId, { limit: 10 }).items).toHaveLength(3);
        expect(audit.purgeBefore(new Date(c.at))).toBe(2);
        expect(audit.list(t.ownerId, { limit: 10 }).items.map((x) => x.id)).toEqual([c.id]);
    });
});

describe('fsRoots', () => {
    it('按 owner 隔离;同一路径不能重复;删除后不再列出', () => {
        const root = t.repos.fsRoots.create(t.ownerId, { path: '/home/u/docs', label: 'Docs' });
        expect(t.repos.fsRoots.list(t.ownerId)).toEqual([root]);
        expect(() => t.repos.fsRoots.create(t.ownerId, { path: '/home/u/docs', label: 'again' })).toThrow();
        expect(t.repos.fsRoots.get('someone-else', root.id)).toBeNull();
        expect(t.repos.fsRoots.delete('someone-else', root.id)).toBe(false);
        expect(t.repos.fsRoots.delete(t.ownerId, root.id)).toBe(true);
        expect(t.repos.fsRoots.list(t.ownerId)).toEqual([]);
    });
});

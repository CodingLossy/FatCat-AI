// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_AGENT_ROLES } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { AgentNameTakenError, BuiltinAgentError } from './agents.js';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories } from './repos.js';
import { createTestDb } from './test-helpers.js';

const input = (name: string) => ({
    name,
    systemPrompt: 'be brief',
    modelProfileId: null,
    toolSet: ['kb.', 'web.fetch'],
    memoryScope: 'shared' as const,
    maxDepth: 2,
    maxSteps: 5,
    budgetTokens: null,
    budgetSeconds: null,
});

describe('agents repository', () => {
    it('creates, updates and deletes custom agents; names are unique per owner', async () => {
        const { repos, ownerId, cleanup } = await createTestDb();
        const a = repos.agents.create(ownerId, input('Writer'));
        expect(a).toMatchObject({ role: 'custom', builtin: false, toolSet: ['kb.', 'web.fetch'] });
        expect(() => repos.agents.create(ownerId, input('Writer'))).toThrow(AgentNameTakenError);
        const updated = repos.agents.update(ownerId, a.id, { toolSet: ['kb.search'], maxSteps: 3 });
        expect(updated).toMatchObject({ toolSet: ['kb.search'], maxSteps: 3, name: 'Writer' });
        expect(repos.agents.delete(ownerId, a.id)).toBe(true);
        expect(repos.agents.get(ownerId, a.id)).toBeNull();
        cleanup();
    });

    it('seeds the built-in roles once, keeps them read-only and survives a name clash', async () => {
        const { repos, ownerId, cleanup } = await createTestDb();
        repos.agents.create(ownerId, input('Researcher'));
        repos.agents.ensureBuiltins(ownerId, BUILTIN_AGENT_ROLES, 'en');
        repos.agents.ensureBuiltins(ownerId, BUILTIN_AGENT_ROLES, 'en');
        const all = repos.agents.list(ownerId);
        const builtin = all.filter((x) => x.builtin);
        expect(builtin).toHaveLength(BUILTIN_AGENT_ROLES.length);
        expect(builtin.find((x) => x.role === 'researcher')?.name).toBe('Researcher (2)');
        const keeper = builtin.find((x) => x.role === 'file-keeper')!;
        expect(() => repos.agents.update(ownerId, keeper.id, { name: 'x' })).toThrow(BuiltinAgentError);
        expect(() => repos.agents.delete(ownerId, keeper.id)).toThrow(BuiltinAgentError);
        cleanup();
    });
});

describe('delegated runs', () => {
    it('sub-runs never stand in for their root run, and the tree and root lookups cover them', async () => {
        const { repos, ownerId, cleanup } = await createTestDb();
        const session = repos.sessions.create(ownerId);
        const user = repos.messages.append(ownerId, session.id, { role: 'user', parts: [], status: 'complete' });
        const root = repos.runs.create(ownerId, { sessionId: session.id, inputMessageId: user.id });
        const child = repos.runs.create(ownerId, {
            sessionId: session.id,
            inputMessageId: user.id,
            parentRunId: root.id,
        });
        const grandchild = repos.runs.create(ownerId, {
            sessionId: session.id,
            inputMessageId: user.id,
            parentRunId: child.id,
        });
        expect(repos.runs.activeInSession(ownerId, session.id)?.id).toBe(root.id);
        expect(repos.runs.latestForInput(ownerId, user.id)?.id).toBe(root.id);
        expect(repos.runs.listTree(ownerId, root.id).map((r) => r.id)).toEqual([root.id, child.id, grandchild.id]);
        expect(repos.runs.rootOf(ownerId, grandchild.id)?.id).toBe(root.id);
        expect(repos.runs.rootOf(ownerId, root.id)?.id).toBe(root.id);
        cleanup();
    });

    it('a parent_run_id cycle in bad data neither hangs the tree query nor the root lookup', async () => {
        const { repos, ownerId, conn, cleanup } = await createTestDb();
        const session = repos.sessions.create(ownerId);
        const user = repos.messages.append(ownerId, session.id, { role: 'user', parts: [], status: 'complete' });
        const a = repos.runs.create(ownerId, { sessionId: session.id, inputMessageId: user.id });
        const b = repos.runs.create(ownerId, { sessionId: session.id, inputMessageId: user.id, parentRunId: a.id });
        conn.sqlite.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run(b.id, a.id);
        expect(
            repos.runs
                .listTree(ownerId, a.id)
                .map((r) => r.id)
                .sort(),
        ).toEqual([a.id, b.id].sort());
        expect(repos.runs.rootOf(ownerId, a.id)).not.toBeNull();
        cleanup();
    });
});

describe('migration 0019', () => {
    it('applies on a database with data after a backup; old runs get no agent and foreign keys stay clean', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m19-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 18),
                { backupDir: join(dir, 'backups') },
            );
            // 迁移前的库里用原始 SQL 造数据(仓储已经按新列写 SQL)
            const exec = (sql: string) => conn.sqlite.prepare(sql).run();
            exec(
                "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
            );
            exec("INSERT INTO sessions (id, owner_id, title, created_at, updated_at) VALUES ('s','o','t','t','t')");
            exec(
                "INSERT INTO messages (id, session_id, owner_id, seq, role, parts_json, status, created_at, updated_at) VALUES ('m','s','o',1,'user','[]','complete','t','t')",
            );
            exec(
                "INSERT INTO runs (id, session_id, owner_id, status, input_message_id, started_at) VALUES ('r1','s','o','succeeded','m','t')",
            );

            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual(migrations.filter((m) => m.id >= 19).map((m) => m.id));
            expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);
            const repos = createRepositories(conn);
            expect(repos.runs.get('o', 'r1')).toMatchObject({ id: 'r1' });
            expect(repos.runs.get('o', 'r1')).not.toHaveProperty('agentId');
            // 删除代理后,运行记录保留,agentId 清空
            const agent = repos.agents.create('o', input('A'));
            const run2 = repos.runs.create('o', {
                sessionId: 's',
                inputMessageId: 'm',
                agentId: agent.id,
            });
            expect(repos.runs.get('o', run2.id)?.agentId).toBe(agent.id);
            repos.agents.delete('o', agent.id);
            expect(repos.runs.get('o', run2.id)).not.toHaveProperty('agentId');
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { BUILTIN_AGENT_ROLES } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { AgentNameTakenError, BuiltinAgentError } from './agents.js';
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

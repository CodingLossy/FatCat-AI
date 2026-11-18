// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { AgentInput, BUILTIN_AGENT_ROLES, effectiveAgentPrompt, toolSetWithin } from './agents.js';

describe('agents contract', () => {
    it('input needs a non-empty tool set and does not accept the "own" memory scope yet', () => {
        const ok = AgentInput.parse({ name: 'a', toolSet: ['kb.search', 'web.'] });
        expect(ok).toMatchObject({ memoryScope: 'shared', maxDepth: 2, maxSteps: 5, budgetTokens: null });
        expect(AgentInput.safeParse({ name: 'a', toolSet: [] }).success).toBe(false);
        expect(AgentInput.safeParse({ name: 'a', toolSet: ['kb.search'], memoryScope: 'own' }).success).toBe(false);
        expect(AgentInput.safeParse({ name: 'a', toolSet: ['has space'] }).success).toBe(false);
    });

    it('built-in roles use the locale prompt; custom agents keep their own', () => {
        const role = BUILTIN_AGENT_ROLES[0]!;
        const builtin = { builtin: true, role: role.role, systemPrompt: '' };
        expect(effectiveAgentPrompt(builtin, 'en')).toBe(role.prompt.en);
        expect(effectiveAgentPrompt(builtin, 'zh-CN')).toBe(role.prompt['zh-CN']);
        expect(effectiveAgentPrompt({ builtin: false, role: 'custom', systemPrompt: 'mine' }, 'en')).toBe('mine');
    });

    it('a tool set can only be narrowed: exact names and prefixes inside the outer set', () => {
        expect(toolSetWithin(['kb.search'], ['kb.'])).toBe(true);
        expect(toolSetWithin(['kb.'], ['kb.'])).toBe(true);
        expect(toolSetWithin(['kb.', 'web.fetch'], ['kb.search', 'web.fetch'])).toBe(false);
        expect(toolSetWithin(['fs.read'], ['kb.', 'web.fetch'])).toBe(false);
        expect(toolSetWithin(['kb.'], ['kb.search'])).toBe(false);
    });
});

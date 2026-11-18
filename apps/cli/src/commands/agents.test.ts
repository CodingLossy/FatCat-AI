// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Agent } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { agentRows, describeAgent } from './agents.js';

const agent = (patch: Partial<Agent> = {}): Agent => ({
    id: '01HZZZZZZZZZZZZZZZZZZZZZZA',
    name: 'Lead',
    role: 'custom',
    builtin: false,
    systemPrompt: 'Plan.\nDelegate.',
    modelProfileId: null,
    toolSet: ['delegate', 'kb.'],
    memoryScope: 'shared',
    maxDepth: 2,
    maxSteps: 5,
    budgetTokens: null,
    budgetSeconds: 60,
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:00Z',
    ...patch,
});

describe('agents command output', () => {
    it('marks agents that can delegate and built-in roles in the list', () => {
        const rows = agentRows([
            agent(),
            agent({ id: 'b', name: 'Researcher', builtin: true, role: 'researcher', toolSet: ['kb.'] }),
        ]);
        expect(rows[1]!.slice(1)).toEqual(['Lead', 'custom', 'shared', '2 (can delegate)']);
        expect(rows[2]!.slice(1)).toEqual(['Researcher', 'built-in (researcher)', 'shared', '1']);
    });

    it('shows the limits and indents the prompt', () => {
        const text = describeAgent(agent()).join('\n');
        expect(text).toContain('limits      depth 2, steps 5, tokens none, seconds 60');
        expect(text).toContain('  Plan.\n  Delegate.');
    });
});

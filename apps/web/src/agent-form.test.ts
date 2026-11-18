// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { emptyDraft, inputOf, parseToolSet } from './agent-form.js';

describe('agent form', () => {
    it('splits the tool set on commas, spaces and newlines and drops duplicates', () => {
        expect(parseToolSet('kb., web.fetch,\n delegate  kb.')).toEqual(['kb.', 'web.fetch', 'delegate']);
        expect(parseToolSet('  ')).toEqual([]);
    });

    it('turns blank limits into null and numbers into numbers', () => {
        const input = inputOf({ ...emptyDraft(), name: ' Lead ', toolSet: 'delegate', budgetSeconds: '90' });
        expect(input).toMatchObject({
            name: 'Lead',
            toolSet: ['delegate'],
            modelProfileId: null,
            maxDepth: 2,
            budgetTokens: null,
            budgetSeconds: 90,
        });
    });

    it('falls back to the default depth and steps when they are left empty', () => {
        const input = inputOf({ ...emptyDraft(), name: 'x', toolSet: 'time', maxDepth: '', maxSteps: ' ' });
        expect([input.maxDepth, input.maxSteps]).toEqual([2, 5]);
    });
});

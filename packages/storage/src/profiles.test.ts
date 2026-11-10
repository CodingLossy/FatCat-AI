// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelProfileInput } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
beforeEach(async () => {
    t = await createTestDb({ now: fakeClock().auto() });
});
afterEach(() => t.cleanup());

const input: ModelProfileInput = {
    label: 'Ollama',
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKeyRef: null,
    model: 'qwen3:8b',
    purpose: ['chat', 'cheap'],
};

describe('modelProfiles', () => {
    it('创建、读取、列表、替换、删除', () => {
        const { modelProfiles } = t.repos;
        const created = modelProfiles.create(t.ownerId, input);
        expect(created).toMatchObject({ ...input });
        expect(created).not.toHaveProperty('contextWindow');
        expect(modelProfiles.get(t.ownerId, created.id)).toEqual(created);
        expect(modelProfiles.list(t.ownerId).map((p) => p.id)).toEqual([created.id]);

        const replaced = modelProfiles.replace(t.ownerId, created.id, {
            ...input,
            apiKeyRef: 'env:DEEPSEEK_API_KEY',
            contextWindow: 65_536,
            params: { temperature: 0.3 },
        })!;
        expect(replaced).toMatchObject({
            apiKeyRef: 'env:DEEPSEEK_API_KEY',
            contextWindow: 65_536,
            params: { temperature: 0.3 },
        });
        expect(replaced.createdAt).toBe(created.createdAt);
        expect(replaced.updatedAt > created.updatedAt).toBe(true);

        expect(modelProfiles.replace(t.ownerId, newId(), input)).toBeNull();
        expect(modelProfiles.delete(t.ownerId, created.id)).toBe(true);
        expect(modelProfiles.get(t.ownerId, created.id)).toBeNull();
    });

    it('其他 owner 看不到', () => {
        const created = t.repos.modelProfiles.create(t.ownerId, input);
        expect(t.repos.modelProfiles.get(newId(), created.id)).toBeNull();
        expect(t.repos.modelProfiles.delete(newId(), created.id)).toBe(false);
    });

    it('kind 只能是已知取值', () => {
        expect(() =>
            t.repos.modelProfiles.create(t.ownerId, { ...input, kind: 'other' as ModelProfileInput['kind'] }),
        ).toThrow(/CHECK/);
    });
});

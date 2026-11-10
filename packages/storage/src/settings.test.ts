// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { DEFAULT_SETTINGS } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
beforeEach(async () => {
    t = await createTestDb({ now: fakeClock().auto() });
});
afterEach(() => t.cleanup());

describe('settings', () => {
    it('没有存储值时返回默认值,部分更新只改给出的键', () => {
        expect(t.repos.settings.get(t.ownerId)).toEqual(DEFAULT_SETTINGS);
        const updated = t.repos.settings.update(t.ownerId, { theme: 'dark', memory: { autoExtract: true } });
        expect(updated).toEqual({
            ...DEFAULT_SETTINGS,
            theme: 'dark',
            memory: { ...DEFAULT_SETTINGS.memory, autoExtract: true },
        });
        expect(t.repos.settings.update(t.ownerId, { locale: 'en' })).toMatchObject({ theme: 'dark', locale: 'en' });
        expect(t.repos.settings.get(t.ownerId).memory.autoExtract).toBe(true);
    });
});

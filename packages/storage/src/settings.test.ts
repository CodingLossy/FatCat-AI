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

    it('默认输入方式默认是语音;老用户已存的语音设置不带它时只补上默认值,其他已存的值不变(ADR 0049 第 1.1 节)', () => {
        expect(t.repos.settings.get(t.ownerId).voice.inputMode).toBe('voice');
        // 模拟 M13 之前保存的 voice 组:没有 inputMode
        const old = { defaultSttProfileId: 'p1', defaultTtsProfileId: null, autoSend: false, autoSpeak: true };
        t.conn.sqlite
            .prepare(
                `INSERT INTO settings (owner_id, key, value_json, updated_at) VALUES (?, 'voice', ?, ?)
                 ON CONFLICT (owner_id, key) DO UPDATE SET value_json = excluded.value_json`,
            )
            .run(t.ownerId, JSON.stringify(old), Date.now());
        t.repos.settings.update(t.ownerId, { theme: 'cat' });
        const read = t.repos.settings.get(t.ownerId);
        expect(read.voice).toEqual({ ...old, inputMode: 'voice', continuous: true, silenceEndSeconds: 8 });
        expect(read.theme).toBe('cat');
        expect(t.repos.settings.update(t.ownerId, { voice: { inputMode: 'text' } }).voice).toEqual({
            ...old,
            inputMode: 'text',
            continuous: true,
            silenceEndSeconds: 8,
        });
    });
});

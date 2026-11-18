// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { PluginSettings } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { formatRss, pickText, settingsDraft, settingsValues } from './plugin-ui.js';

const schema: PluginSettings = {
    type: 'object',
    properties: {
        city: { type: 'string', default: 'Paris' },
        days: { type: 'number' },
        alerts: { type: 'boolean', default: true },
    },
};

describe('plugin page helpers', () => {
    it('shows plugin text in the interface language and falls back to the other one', () => {
        expect(pickText({ 'zh-CN': '天气', en: 'Weather' }, 'zh-CN')).toBe('天气');
        expect(pickText({ en: 'Weather' }, 'zh-CN')).toBe('Weather');
        expect(pickText({ 'zh-CN': '天气' }, 'en')).toBe('天气');
    });

    it('starts the settings form from saved values, then defaults', () => {
        expect(settingsDraft(schema, {})).toEqual({ city: 'Paris', days: '', alerts: true });
        expect(settingsDraft(schema, { city: 'Rome', days: 3, alerts: false })).toEqual({
            city: 'Rome',
            days: '3',
            alerts: false,
        });
    });

    it('turns the draft into settings, skips empty optionals and flags bad numbers', () => {
        expect(settingsValues(schema, { city: 'Rome', days: '', alerts: false })).toEqual({
            values: { city: 'Rome', alerts: false },
            invalid: [],
        });
        expect(settingsValues(schema, { city: '', days: '3', alerts: true }).values).toEqual({
            days: 3,
            alerts: true,
        });
        expect(settingsValues(schema, { city: 'x', days: 'abc', alerts: true }).invalid).toEqual(['days']);
    });

    it('formats memory readings', () => {
        expect(formatRss(null)).toBeNull();
        expect(formatRss(52_428_800)).toBe('50.0 MiB');
    });
});

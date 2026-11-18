// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { PluginSettings } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import {
    defaultMarketVersion,
    formatRss,
    marketErrorKey,
    permissionSummary,
    pickText,
    secretRefChanges,
    settingsDraft,
    settingsValues,
} from './plugin-ui.js';

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

describe('settings form with required keys that have defaults', () => {
    const required: PluginSettings = {
        type: 'object',
        properties: {
            city: { type: 'string', default: 'Paris' },
            unit: { type: 'string', enum: ['c', 'f'], default: 'c' },
        },
        required: ['city', 'unit'],
    };

    it('submits the declared defaults when the user changes nothing, so the server does not reject the form', () => {
        const draft = settingsDraft(required, {});
        expect(settingsValues(required, draft)).toEqual({ values: { city: 'Paris', unit: 'c' }, invalid: [] });
    });
});

describe('plugin market helpers', () => {
    it('summarises what a version asks for, leaving out empty groups', () => {
        const permissions = {
            tools: [{ name: 'a', risk: 'read' as const }],
            net: ['example.com', 'api.example.com'],
            secrets: [],
            items: { categories: [] },
        };
        expect(permissionSummary(permissions as never)).toEqual([
            { key: 'tools', count: 1 },
            { key: 'net', count: 2 },
        ]);
        expect(permissionSummary({ tools: [], net: [], secrets: [] })).toEqual([]);
    });

    it('preselects the newest compatible version, or the newest one when none is compatible', () => {
        expect(
            defaultMarketVersion([
                { version: '2.0.0', compatible: false },
                { version: '1.2.0', compatible: true },
            ]),
        ).toBe('1.2.0');
        expect(defaultMarketVersion([{ version: '2.0.0', compatible: false }])).toBe('2.0.0');
        expect(defaultMarketVersion([])).toBeNull();
    });

    it('maps known index error codes to messages and leaves unknown ones to the server text', () => {
        expect(marketErrorKey('index_signature_invalid')).toBe('plugins.market.err.index_signature_invalid');
        expect(marketErrorKey('something_new')).toBeNull();
    });
});

describe('secret binding changes', () => {
    it('writes new values, unbinds a cleared binding with null and leaves untouched boxes out', () => {
        expect(
            secretRefChanges(
                { A: 'env:NEW', B: '', C: 'env:SAME', D: '', E: '  env:TRIM  ' },
                { A: 'env:OLD', B: 'env:GONE', C: 'env:SAME' },
            ),
        ).toEqual({ A: 'env:NEW', B: null, E: 'env:TRIM' });
    });
});

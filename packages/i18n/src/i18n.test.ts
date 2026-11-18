// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    checkDictionaries,
    dictionaries,
    formatMessage,
    promptText,
    resolveLocale,
    translator,
    formatRelative,
} from './index.js';

describe('formatMessage', () => {
    it('substitutes variables and keeps unknown ones visible', () => {
        expect(formatMessage('Hi {name}, {x}', { name: 'A' }, 'en')).toBe('Hi A, {x}');
    });
    it('handles plural with # and exact matches', () => {
        const m = '{n, plural, =0 {none} one {# file} other {# files}}';
        expect(formatMessage(m, { n: 0 }, 'en')).toBe('none');
        expect(formatMessage(m, { n: 1 }, 'en')).toBe('1 file');
        expect(formatMessage(m, { n: 1200 }, 'en')).toBe('1,200 files');
        expect(formatMessage('{n, plural, other {# 个}}', { n: 3 }, 'zh-CN')).toBe('3 个');
    });
    it('handles select with fallback to other', () => {
        const m = '{k, select, a {A} other {?}}';
        expect(formatMessage(m, { k: 'a' }, 'en')).toBe('A');
        expect(formatMessage(m, { k: 'z' }, 'en')).toBe('?');
    });
    it('rejects unsupported syntax', () => {
        expect(() => formatMessage('{n, number}', { n: 1 }, 'en')).toThrow();
        expect(() => formatMessage('{n, plural, one {x}}', { n: 1 }, 'en')).toThrow();
        expect(() => formatMessage('oops {', undefined, 'en')).toThrow();
    });
});

describe('dictionaries', () => {
    it('every message parses and both languages agree on keys and arguments', () => {
        expect(checkDictionaries(dictionaries)).toEqual([]);
    });
    it('reports problems', () => {
        const bad = { 'zh-CN': { a: '{x}' }, en: { a: '{y}', b: 'z' } };
        expect(checkDictionaries(bad)).toHaveLength(2);
    });
    it('translator formats', () => {
        expect(translator('en')('chat.failed', { msg: 'x' })).toBe('Something went wrong: x');
    });
});

describe('locale and helpers', () => {
    it('resolves settings, browser languages, then en', () => {
        expect(resolveLocale('en', ['zh-CN'])).toBe('en');
        expect(resolveLocale(null, ['fr-FR', 'zh-TW'])).toBe('zh-CN');
        expect(resolveLocale(undefined, ['fr'])).toBe('en');
    });
    it('prompt templates per language', () => {
        expect(promptText('currentTime', 'en', { time: 'T' })).toBe('Current time: T.');
        expect(promptText('usingTool', 'zh-CN', { name: 'fs.read' })).toBe('正在使用 fs.read…');
    });
    it('formats relative time', () => {
        expect(formatRelative(0, 'en', 3 * 60_000)).toBe('3 minutes ago');
    });
});

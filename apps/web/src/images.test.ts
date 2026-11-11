// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelProfile } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { effectiveProfile, fitWithin, precheck } from './images.js';

const profile = (id: string, over: Partial<ModelProfile> = {}) =>
    ({ id, label: id, purpose: ['chat'], ...over }) as ModelProfile;

describe('fitWithin', () => {
    it('长边缩到 2048,保持比例;小图不变', () => {
        expect(fitWithin(4096, 3072)).toEqual({ width: 2048, height: 1536 });
        expect(fitWithin(1000, 8000)).toEqual({ width: 256, height: 2048 });
        expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    });
});

describe('precheck', () => {
    it('只接受四种图片;过大的 GIF 直接拒绝', () => {
        expect(precheck(new File([], 'a.png', { type: 'image/png' }))).toBe('ok');
        expect(precheck(new File([], 'a.svg', { type: 'image/svg+xml' }))).toBe('type');
        expect(precheck(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'a.gif', { type: 'image/gif' }))).toBe('size');
    });
});

describe('effectiveProfile', () => {
    it('会话设置 > 默认 chat > 第一个 chat 配置档', () => {
        const profiles = [profile('cheap', { purpose: ['cheap'] }), profile('a'), profile('b', { vision: true })];
        expect(effectiveProfile(profiles, { defaultChatProfileId: null }, { modelProfileId: 'b' })?.id).toBe('b');
        expect(effectiveProfile(profiles, { defaultChatProfileId: 'b' }, { modelProfileId: null })?.id).toBe('b');
        expect(effectiveProfile(profiles, null, null)?.id).toBe('a');
        expect(effectiveProfile([], null, null)).toBeNull();
    });
});

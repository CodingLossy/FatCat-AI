// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { assistantLabel } from './labels.js';

describe('assistantLabel', () => {
    it('按界面语言生成;executing 优先用工具的 activityLabel', () => {
        expect(assistantLabel('thinking', 'zh-CN')).toBe('正在思考…');
        expect(assistantLabel('listening', 'en')).toBe('Listening…');
        const tool = { name: 'mail.send', activityLabel: { 'zh-CN': '正在发送邮件…', en: 'Sending email…' } };
        expect(assistantLabel('executing', 'en', tool)).toBe('Sending email…');
        expect(assistantLabel('executing', 'zh-CN', { name: 'mcp.notes.add' })).toBe('正在使用 mcp.notes.add…');
    });
});

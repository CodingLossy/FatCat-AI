// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { SkillInfo } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import {
    AGENT_MAX_SKILLS,
    agentSkillState,
    catalogOverflow,
    entriesOverlap,
    fitsToolSet,
    toggleSkill,
} from './skills-ui.js';

const skill = (id: string, toolSet: string[], enabled = true): SkillInfo => ({
    id,
    name: { en: id },
    description: 'd',
    source: 'builtin',
    pluginId: null,
    enabled,
    toolSet,
    taskTemplates: [],
});

describe('Skill 界面(ADR 0048)', () => {
    it('工具集条目按前缀判断交集', () => {
        expect(entriesOverlap('fs.', 'fs.read')).toBe(true);
        expect(entriesOverlap('fs.read', 'fs.')).toBe(true);
        expect(entriesOverlap('fs.read', 'fs.read')).toBe(true);
        expect(entriesOverlap('fs.read', 'fs.write')).toBe(false);
        expect(entriesOverlap('fs', 'fs.read')).toBe(false);
        expect(fitsToolSet(['web.fetch', 'browser.'], ['browser.open', 'kb.'])).toBe(true);
        expect(fitsToolSet(['mail.'], ['kb.', 'fs.read'])).toBe(false);
    });

    it('代理里的 Skill:不存在、已停用、工具集不含、可用', () => {
        const skills = [skill('local-files', ['fs.', 'kb.search']), skill('mail-assistant', ['mail.'], false)];
        expect(agentSkillState('nope', skills, ['fs.'])).toBe('missing');
        expect(agentSkillState('mail-assistant', skills, ['mail.'])).toBe('off');
        expect(agentSkillState('local-files', skills, ['web.fetch'])).toBe('noTools');
        expect(agentSkillState('local-files', skills, ['kb.'])).toBe('ok');
    });

    it('插件被停用后,它的 Skill 在代理里显示「未启用」', () => {
        const minutes: SkillInfo = {
            ...skill('plugin.notes.minutes', ['fs.read', 'fs.write'], false),
            source: 'plugin',
            pluginId: 'notes',
        };
        expect(agentSkillState('plugin.notes.minutes', [minutes], ['fs.'])).toBe('off');
        expect(agentSkillState('plugin.notes.minutes', [{ ...minutes, enabled: true }], ['fs.'])).toBe('ok');
    });

    it('勾选最多 AGENT_MAX_SKILLS(8)个;目录超过 30 个启用的 Skill 时提示', () => {
        expect(AGENT_MAX_SKILLS).toBe(8);
        const eight = Array.from({ length: AGENT_MAX_SKILLS }, (_, i) => `s${i}x`);
        expect(toggleSkill(eight, 'extra')).toEqual(eight);
        expect(toggleSkill(eight, 's0x')).toHaveLength(7);
        expect(toggleSkill([], 'a1')).toEqual(['a1']);
        const many = Array.from({ length: 31 }, (_, i) => skill(`s${i}x`, ['fs.']));
        expect(catalogOverflow(many)).toBe(true);
        expect(catalogOverflow(many.map((s, i) => ({ ...s, enabled: i > 0 })))).toBe(false);
    });
});

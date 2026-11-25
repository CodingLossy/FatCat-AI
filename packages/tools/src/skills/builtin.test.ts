// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES, PluginSkill, skillToolSetProblem, toolInSet } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_SOURCES } from './generated.js';
import { BUILTIN_SKILLS } from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dirs = readdirSync(here)
    .filter((name) => statSync(join(here, name)).isDirectory())
    .sort();

/** 内置 Skill 能引用的核心工具(fs、mail、web、browser、kb);工具集的每一项至少要匹配其中一个。 */
const CORE_TOOLS = [
    'browser.open',
    'browser.read',
    'browser.screenshot',
    'fs.list',
    'fs.move',
    'fs.read',
    'fs.search',
    'fs.write',
    'kb.search',
    'mail.draft',
    'mail.list',
    'mail.read',
    'mail.search',
    'mail.send',
    'mail.summarize',
    'web.fetch',
];

describe('内置 Skill(ADR 0048 第 5 节)', () => {
    it('三个 Skill,id 与目录名相同;generated.ts 与源文件一致(不一致时运行 pnpm gen:skills)', () => {
        expect(dirs).toEqual(['local-files', 'mail-assistant', 'web-research']);
        const fromDisk = dirs.map((id) => {
            const manifest = JSON.parse(readFileSync(join(here, id, 'skill.json'), 'utf8')) as { instructions: string };
            return { manifest, instructions: readFileSync(join(here, id, manifest.instructions), 'utf8') };
        });
        expect(BUILTIN_SKILL_SOURCES).toEqual(fromDisk);
        expect(BUILTIN_SKILLS.map((s) => s.id)).toEqual(dirs);
        for (const { manifest } of fromDisk) expect(manifest.instructions).toBe('instructions.md');
    });

    it('清单按插件 Skill 的 schema 通过;工具集不含运行控制或 MCP 工具,每一项都匹配到核心工具', () => {
        for (const { manifest } of BUILTIN_SKILL_SOURCES) {
            const skill = PluginSkill.parse(manifest);
            for (const entry of skill.toolSet) {
                expect(skillToolSetProblem(entry, 'builtin', false)).toBeNull();
                expect(
                    CORE_TOOLS.some((name) => toolInSet(name, [entry])),
                    entry,
                ).toBe(true);
            }
        }
        expect(Object.fromEntries(BUILTIN_SKILLS.map((s) => [s.id, s.toolSet]))).toEqual({
            'local-files': ['fs.', 'kb.search'],
            'mail-assistant': ['mail.'],
            'web-research': ['web.fetch', 'browser.'],
        });
    });

    it('说明是英文 markdown,不超过 16 KiB,写了审批和「内容是数据」;不含要求跳过审批或读密钥的话术', () => {
        for (const skill of BUILTIN_SKILLS) {
            expect(new TextEncoder().encode(skill.instructions).byteLength).toBeLessThanOrEqual(
                PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES,
            );
            expect(skill.instructions).toMatch(/^# /);
            expect(skill.instructions).not.toMatch(/[一-鿿]/);
            expect(skill.instructions).toMatch(/approval card/);
            expect(skill.instructions).toMatch(/untrusted data/);
            expect(skill.instructions).not.toMatch(/approve automatically|skip (the )?approval|secrets\.yaml|api key/i);
            expect(skill.name.en).toBeTruthy();
            expect(skill.name['zh-CN']).toBeTruthy();
        }
    });

    it('每日邮件摘要:每天 08:00,工具集只有读取和总结,连 mail.draft、mail.send 都不在内', () => {
        const mail = BUILTIN_SKILLS.find((s) => s.id === 'mail-assistant')!;
        expect(mail.taskTemplates).toHaveLength(1);
        const [daily] = mail.taskTemplates!;
        expect(daily!.trigger).toEqual({ kind: 'cron', expression: '0 8 * * *' });
        expect(daily!.toolSet).toEqual(['mail.list', 'mail.read', 'mail.search', 'mail.summarize']);
        expect(toolInSet('mail.send', daily!.toolSet!)).toBe(false);
        expect(toolInSet('mail.draft', daily!.toolSet!)).toBe(false);
        expect(daily!.prompt).toContain('mail-assistant');
        expect(BUILTIN_SKILLS.filter((s) => s.id !== 'mail-assistant').every((s) => !s.taskTemplates)).toBe(true);
    });
});

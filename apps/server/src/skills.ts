// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 已安装的 Skill(ADR 0048 第 2、5、8 节):内置 Skill 与已安装插件声明的 Skill。插件 Skill 的启用状态就是所属插件的
// 启用状态;内置 Skill 的开关在 settings 的 `skills.builtin`(缺省启用)。说明运行时从已安装的包目录读取,不入库。
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { RunSkill, SkillSource } from '@fatcat-ai/agent';
import {
    PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES,
    type PluginManifest,
    type PluginSkillTaskTemplate,
    type PluginText,
    pluginSkillId,
    type SkillInfo,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { hashPluginDir } from '@fatcat-ai/tools/market';

/** 内置 Skill(随核心发布,`feat/builtin-skills` 起提供):清单字段与说明原文。 */
export interface BuiltinSkill {
    id: string;
    name: PluginText;
    description: string;
    toolSet: string[];
    taskTemplates?: PluginSkillTaskTemplate[];
    instructions: string;
}

export interface SkillServiceOptions {
    repos: Repositories;
    /** 插件代码目录(`<dataDir>/plugins`),包在 `<codeRoot>/<id>/<version>/`。 */
    codeRoot: string;
    builtin?: readonly BuiltinSkill[];
}

interface Entry {
    info: SkillInfo;
    /** 插件 Skill:说明文件的绝对路径;内置 Skill:说明原文。 */
    read: () => string | null;
}

export class SkillService implements SkillSource {
    constructor(private readonly options: SkillServiceOptions) {}

    private entries(ownerId: string): Entry[] {
        const { repos, codeRoot } = this.options;
        const toggles = repos.settings.get(ownerId).skills?.builtin ?? {};
        const out: Entry[] = (this.options.builtin ?? []).map((skill) => ({
            info: {
                id: skill.id,
                name: skill.name,
                description: skill.description,
                source: 'builtin',
                pluginId: null,
                enabled: toggles[skill.id] !== false,
                toolSet: skill.toolSet,
                taskTemplates: skill.taskTemplates ?? [],
            },
            read: () => skill.instructions,
        }));
        for (const record of repos.plugins.list(ownerId)) {
            if (record.state === 'uninstalled') continue;
            const manifest = record.manifest as PluginManifest;
            const dir = join(codeRoot, record.pluginId, record.version);
            for (const skill of manifest.skills ?? []) {
                out.push({
                    info: {
                        id: pluginSkillId(record.pluginId, skill.id),
                        name: skill.name,
                        description: skill.description,
                        source: 'plugin',
                        pluginId: record.pluginId,
                        enabled: record.state === 'enabled',
                        toolSet: skill.toolSet,
                        taskTemplates: skill.taskTemplates ?? [],
                    },
                    read: () =>
                        packageIntact(dir, record.contentSha256) ? readInstructions(dir, skill.instructions) : null,
                });
            }
        }
        return out.sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0));
    }

    /** GET /api/v1/skills:全部已安装的 Skill(含已停用的),按 id 排序。 */
    all(ownerId: string): SkillInfo[] {
        return this.entries(ownerId).map((e) => e.info);
    }

    list(ownerId: string): RunSkill[] {
        return this.entries(ownerId)
            .filter((e) => e.info.enabled)
            .map(({ info }) => ({
                id: info.id,
                description: info.description,
                toolSet: info.toolSet,
                source: info.source,
            }));
    }

    instructions(ownerId: string, id: string): string | null {
        const entry = this.entries(ownerId).find((e) => e.info.id === id && e.info.enabled);
        return entry ? entry.read() : null;
    }
}

/**
 * 读说明前再核对一次包的校验和(ADR 0040 第 5.4 节):启动时的核对只覆盖那一刻,之后被改过的包不再交出说明。
 * 纯指令插件的包只有清单和 markdown,通常只有几 KiB,每次 skill.use 重算的开销可以忽略。
 */
function packageIntact(dir: string, expected: string): boolean {
    try {
        return hashPluginDir(dir) === expected;
    } catch {
        return false;
    }
}

/** 从已安装的包里读说明:路径必须在包目录之内、是普通文件、不超过 16 KiB、是合法 UTF-8;否则 null。 */
function readInstructions(dir: string, rel: string): string | null {
    const path = resolve(dir, rel);
    const inside = relative(dir, path);
    if (inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`)) return null;
    let fd: number | null = null;
    try {
        // 先打开再对同一个句柄检查和读取,避免检查之后文件被换掉;POSIX 上不跟随符号链接
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES) return null;
        const bytes = readFileSync(fd);
        if (bytes.byteLength > PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES) return null;
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    } finally {
        if (fd !== null) closeSync(fd);
    }
}

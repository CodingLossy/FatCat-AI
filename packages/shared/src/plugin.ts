// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件清单 plugin.json、市场索引与 fatcat/* 扩展消息的公开契约(ADR 0040 第 2、3.3、5.2 节)。
// 宿主、SDK 的校验命令与索引仓库 CI 共用这一份;本文件只定义形状与纯函数校验,不含任何运行时行为。
import { z } from 'zod';
import { AgentToolSetEntry, toolSetWithin } from './agents.js';
import { IsoDateTime } from './common.js';
import { parseDomainScope } from './domain-scope.js';
import { isOwnEnvName } from './rename.js';
import { TaskTrigger } from './tasks.js';

// ───────────────────────── 通用片段 ─────────────────────────

/** 清单上限:64 KiB(UTF-8 字节数)。 */
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
/** 单个插件包上限(ADR 0040 第 5.3 节)。 */
export const PLUGIN_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
/** 条目 `meta` 的上限(ADR 0040 第 3.3 节)。 */
export const PLUGIN_ITEM_META_MAX_BYTES = 8 * 1024;

export const PLUGIN_LOCALES = ['zh-CN', 'en'] as const;

/** i18n 文案:至少一种语言,每项不超过 max 个字符;未知语言一律拒绝。 */
export function pluginText(max: number) {
    return z
        .strictObject({ 'zh-CN': z.string().min(1).max(max).optional(), en: z.string().min(1).max(max).optional() })
        .refine((value) => value['zh-CN'] !== undefined || value.en !== undefined, 'at least one language is required');
}
export type PluginText = z.infer<ReturnType<typeof pluginText>>;

export const PluginId = z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits or "-" (2 to 32)')
    // `GET /plugins/market` 是市场入口,不能被一个叫 market 的插件抢走
    .refine((id) => id !== 'market', 'the id "market" is reserved');

// ───────────────────────── 版本与 engines ─────────────────────────

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    /** 预发布标识(`-` 之后),没有则为空数组。 */
    pre: string[];
}

/** 解析 `MAJOR.MINOR.PATCH[-pre]`;不支持 `+build`,不合法返回 null。 */
export function parseSemver(text: string): SemVer | null {
    const match = SEMVER.exec(text);
    if (!match) return null;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) return null;
    return { major, minor, patch, pre: match[4] ? match[4].split('.') : [] };
}

/** 按 semver 规则比较:先比主次修订;有预发布标识的小于没有的;预发布标识逐段比较。 */
export function compareSemver(a: SemVer, b: SemVer): number {
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    if (a.pre.length === 0 && b.pre.length === 0) return 0;
    if (a.pre.length === 0) return 1;
    if (b.pre.length === 0) return -1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i];
        const y = b.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
        if (xn) return -1;
        if (yn) return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

export interface EngineRange {
    min: SemVer;
    /** 不含;没有写上界则为 null。 */
    maxExclusive: SemVer | null;
}

/** 解析 `>=1.1.0` 或 `>=1.1.0 <2.0.0` 两种写法;其他写法返回 null。 */
export function parseEngineRange(text: string): EngineRange | null {
    const match = /^>=(\S+)(?: <(\S+))?$/.exec(text);
    if (!match) return null;
    const min = parseSemver(match[1] ?? '');
    if (!min) return null;
    if (match[2] === undefined) return { min, maxExclusive: null };
    const max = parseSemver(match[2]);
    if (!max || compareSemver(max, min) <= 0) return null;
    return { min, maxExclusive: max };
}

/** 核心版本是否在 engines 范围内;范围不合法时返回 false。预发布版本的核心按 semver 规则比较。 */
export function satisfiesEngine(coreVersion: string, range: string): boolean {
    const core = parseSemver(coreVersion);
    const parsed = parseEngineRange(range);
    if (!core || !parsed) return false;
    if (compareSemver(core, parsed.min) < 0) return false;
    return parsed.maxExclusive === null || compareSemver(core, parsed.maxExclusive) < 0;
}

export const PluginVersion = z
    .string()
    .refine((value) => parseSemver(value) !== null, 'must be MAJOR.MINOR.PATCH[-pre]');
export const PluginEngineRange = z
    .string()
    .max(64)
    .refine((value) => parseEngineRange(value) !== null, {
        message: 'must look like ">=1.1.0" or ">=1.1.0 <2.0.0"',
    });

// ───────────────────────── 权限 ─────────────────────────

/** M7 插件只能声明这三个级别;`dangerous` 不接受(ADR 0040 第 2 节)。 */
export const PluginToolRisk = z.enum(['read', 'write', 'external']);
export type PluginToolRisk = z.infer<typeof PluginToolRisk>;

/** 工具名:注册为 `plugin.<id>.<tool>`。 */
export const PluginToolName = z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,47}$/, 'lowercase letters, digits, "_" or "-" (1 to 48)');

export const PluginToolPermission = z.strictObject({
    name: PluginToolName,
    risk: PluginToolRisk,
    /** 这个工具会把用户的数据发到外部服务;实际级别至少为 external,不可预授权。 */
    sendsData: z.boolean().optional(),
    /** 允许按域名约束预授权(约束参数名固定为 `url`,ADR 0039)。 */
    constraint: z.literal('domain').optional(),
});
export type PluginToolPermission = z.infer<typeof PluginToolPermission>;

/** 联网域名:写法与校验同 ADR 0039,必须是规范写法(小写),`broad`(如 `*.com`)拒绝。 */
export const PluginNetDomain = z.string().superRefine((value, ctx) => {
    const parsed = parseDomainScope(value);
    if ('problem' in parsed) {
        ctx.addIssue({ code: 'custom', message: `invalid domain (${parsed.problem})` });
    } else if (parsed.ok !== value) {
        ctx.addIssue({ code: 'custom', message: `write the domain as "${parsed.ok}"` });
    }
});

/** 密钥名:大写环境变量风格;不得以 FATCAT_AI_ / AIP_ 开头。 */
export const PluginSecretName = z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'uppercase letters, digits or "_" (1 to 64)')
    .refine((name) => !isOwnEnvName(name), 'FATCAT_AI_* and AIP_* names are reserved');

export const PluginSecretPermission = z.strictObject({
    name: PluginSecretName,
    required: z.boolean().default(false),
    description: pluginText(200).optional(),
});

export const PluginItemCategory = z.strictObject({
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, "_" or "-" (1 to 32)'),
    title: pluginText(64),
});
export type PluginItemCategory = z.infer<typeof PluginItemCategory>;

function unique<T>(values: T[], key: (value: T) => string): boolean {
    return new Set(values.map(key)).size === values.length;
}

export const PluginPermissions = z.strictObject({
    tools: z
        .array(PluginToolPermission)
        .max(50)
        .refine((tools) => unique(tools, (t) => t.name), 'duplicate tool name')
        .default([]),
    net: z
        .array(PluginNetDomain)
        .max(20)
        .refine((domains) => unique(domains, (d) => d), 'duplicate domain')
        .default([]),
    secrets: z
        .array(PluginSecretPermission)
        .max(8)
        .refine((secrets) => unique(secrets, (s) => s.name), 'duplicate secret name')
        .default([]),
    items: z
        .strictObject({
            categories: z
                .array(PluginItemCategory)
                .max(10)
                .refine((categories) => unique(categories, (c) => c.type), 'duplicate category type'),
        })
        .optional(),
});
export type PluginPermissions = z.infer<typeof PluginPermissions>;

// ───────────────────────── 升级时的权限对比(第 6.2 节) ─────────────────────────

export const PluginPermissionChange = z.object({
    kind: z.enum(['tool', 'tool-risk', 'tool-sends-data', 'net', 'secret', 'category']),
    /** 工具名、域名、密钥名或条目类别。 */
    name: z.string(),
    /** `tool-risk` 的旧级别;其他为 null。 */
    from: z.string().nullable(),
    /** `tool` 的级别、`tool-risk` 的新级别;其他为 null。 */
    to: z.string().nullable(),
});
export type PluginPermissionChange = z.infer<typeof PluginPermissionChange>;

/** `added` 里的任何一条都需要用户同意;`removed` 只是告知。 */
export const PluginPermissionDiff = z.object({
    added: z.array(PluginPermissionChange),
    removed: z.array(PluginPermissionChange),
});
export type PluginPermissionDiff = z.infer<typeof PluginPermissionDiff>;

const RISK_RANK: Record<string, number> = { read: 0, write: 1, external: 2 };
const riskRank = (risk: string): number => RISK_RANK[risk] ?? 0;

/**
 * 新版本相对已授权范围的权限变化:新工具、工具级别升高、新增 `sendsData`、新域名、新密钥、新条目类别算「新增」;
 * 反方向算「减少」。授权以清单为准,所以这里只比清单里的权限。
 */
export function diffPermissions(granted: PluginPermissions, next: PluginPermissions): PluginPermissionDiff {
    const added: PluginPermissionChange[] = [];
    const removed: PluginPermissionChange[] = [];
    const change = (
        kind: PluginPermissionChange['kind'],
        name: string,
        from: string | null = null,
        to: string | null = null,
    ): PluginPermissionChange => ({ kind, name, from, to });
    const oldTools = new Map(granted.tools.map((t) => [t.name, t]));
    const newTools = new Map(next.tools.map((t) => [t.name, t]));
    for (const [name, tool] of newTools) {
        const before = oldTools.get(name);
        if (!before) {
            added.push(change('tool', name, null, tool.risk));
            continue;
        }
        if (riskRank(tool.risk) > riskRank(before.risk)) added.push(change('tool-risk', name, before.risk, tool.risk));
        else if (riskRank(tool.risk) < riskRank(before.risk))
            removed.push(change('tool-risk', name, before.risk, tool.risk));
        if (tool.sendsData === true && before.sendsData !== true) added.push(change('tool-sends-data', name));
        else if (before.sendsData === true && tool.sendsData !== true) removed.push(change('tool-sends-data', name));
    }
    for (const [name, tool] of oldTools) if (!newTools.has(name)) removed.push(change('tool', name, null, tool.risk));
    const both = <T>(
        before: T[],
        after: T[],
        key: (value: T) => string,
        kind: PluginPermissionChange['kind'],
    ): void => {
        const had = new Set(before.map(key));
        const has = new Set(after.map(key));
        for (const name of has) if (!had.has(name)) added.push(change(kind, name));
        for (const name of had) if (!has.has(name)) removed.push(change(kind, name));
    };
    both(granted.net, next.net, (d) => d, 'net');
    both(granted.secrets, next.secrets, (s) => s.name, 'secret');
    both(granted.items?.categories ?? [], next.items?.categories ?? [], (c) => c.type, 'category');
    return { added, removed };
}

// ───────────────────────── 入口、设置、任务模板、变现 ─────────────────────────

/** 包内相对路径:不含反斜杠、盘符或冒号,不以 `/` 开头,没有空段、`.`、`..`。 */
function isPackagePath(path: string): boolean {
    return (
        !path.includes('\\') &&
        !path.includes(':') &&
        !path.startsWith('/') &&
        path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    );
}

/** 包内相对路径:不能是绝对路径、含 `..` 或盘符,只能是 `.js` / `.mjs`。 */
export const PluginEntryMain = z
    .string()
    .min(1)
    .max(200)
    .refine(
        (path) => isPackagePath(path) && /\.m?js$/.test(path),
        'must be a relative path inside the package ending in .js or .mjs',
    );

export const PluginEntry = z.strictObject({ type: z.literal('mcp-stdio'), main: PluginEntryMain });

const SettingKey = z
    .string()
    .regex(/^[a-z][A-Za-z0-9_]{0,31}$/, 'letters, digits or "_" (1 to 32), starting lowercase');
const SettingBase = { title: pluginText(64).optional(), description: pluginText(200).optional() };

/** 设置项:JSON Schema 子集,只有 string(可带 enum)/ number / boolean。 */
export const PluginSettingProperty = z.discriminatedUnion('type', [
    z
        .strictObject({
            type: z.literal('string'),
            ...SettingBase,
            default: z.string().max(500).optional(),
            maxLength: z.number().int().min(1).max(2000).optional(),
            enum: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
        })
        .refine((p) => p.enum === undefined || p.default === undefined || p.enum.includes(p.default), {
            message: 'default must be one of enum',
            path: ['default'],
        }),
    z
        .strictObject({
            type: z.literal('number'),
            ...SettingBase,
            default: z.number().optional(),
            minimum: z.number().optional(),
            maximum: z.number().optional(),
        })
        .refine((p) => p.minimum === undefined || p.maximum === undefined || p.minimum <= p.maximum, {
            message: 'minimum must not exceed maximum',
            path: ['minimum'],
        }),
    z.strictObject({ type: z.literal('boolean'), ...SettingBase, default: z.boolean().optional() }),
]);
export type PluginSettingProperty = z.infer<typeof PluginSettingProperty>;

export const PluginSettings = z
    .strictObject({
        type: z.literal('object'),
        properties: z
            .record(SettingKey, PluginSettingProperty)
            .refine((props) => Object.keys(props).length <= 20, 'at most 20 settings'),
        required: z.array(SettingKey).max(20).optional(),
    })
    .refine((s) => (s.required ?? []).every((key) => key in s.properties), {
        message: 'required lists an unknown setting',
        path: ['required'],
    });
export type PluginSettings = z.infer<typeof PluginSettings>;

/**
 * 按清单的 `settings` 声明检查用户填的设置值(第 9 节 `PATCH /plugins/{id}`):未声明的键、类型不对、不在 enum 里、
 * 超出长度或范围、缺少必填项都算问题。返回问题列表,空数组表示通过;不改动传入的值。
 */
export function validatePluginSettings(schema: PluginSettings | undefined, values: Record<string, unknown>): string[] {
    const issues: string[] = [];
    const properties = schema?.properties ?? {};
    for (const [key, value] of Object.entries(values)) {
        // 只认自己声明的键:`constructor`、`__proto__` 这类原型链上的名字不算声明
        const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (!prop) {
            issues.push(`${key}: not declared by the plugin`);
        } else if (prop.type === 'string') {
            if (typeof value !== 'string') issues.push(`${key}: must be a string`);
            else if (prop.maxLength !== undefined && value.length > prop.maxLength) {
                issues.push(`${key}: at most ${prop.maxLength} characters`);
            } else if (prop.enum && !prop.enum.includes(value)) issues.push(`${key}: not one of the allowed values`);
        } else if (prop.type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) issues.push(`${key}: must be a number`);
            else if (prop.minimum !== undefined && value < prop.minimum)
                issues.push(`${key}: at least ${prop.minimum}`);
            else if (prop.maximum !== undefined && value > prop.maximum) issues.push(`${key}: at most ${prop.maximum}`);
        } else if (typeof value !== 'boolean') {
            issues.push(`${key}: must be true or false`);
        }
    }
    for (const key of schema?.required ?? []) {
        const value = values[key];
        if (value === undefined || value === '') issues.push(`${key}: required`);
    }
    return issues;
}

/**
 * 定时任务模板(ADR 0033 的任务草稿格式)。只是模板:用户确认后才建任务,不能带预授权。
 * 触发器只接受 cron 与不指定账户的 mail_received(其余需要用户环境里的 id 或绝对时刻)。
 */
export const PluginTaskTemplate = z.strictObject({
    title: pluginText(80),
    prompt: z.string().trim().min(1).max(2000),
    trigger: TaskTrigger.refine(
        (t) => t.kind === 'cron' || (t.kind === 'mail_received' && t.accountId === undefined),
        'only "cron" and "mail_received" (without accountId) triggers are allowed in templates',
    ),
});
export type PluginTaskTemplate = z.infer<typeof PluginTaskTemplate>;

// ───────────────────────── Skills(ADR 0048 第 1、2 节) ─────────────────────────

/** Skill 的 instructions 上限:16 KiB(UTF-8 字节数),安装时检查。 */
export const PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
/** 声明了 `skills` 或省略了 `entry` 的清单,`engines.fatcat` 下限至少是这个版本(Skills 随核心 1.2.0 发布)。 */
export const PLUGIN_SKILLS_MIN_CORE = '1.2.0';
/** 每个插件最多 10 个 Skill;插件级与各 Skill 的任务模板合计最多 10 个。 */
export const PLUGIN_MAX_SKILLS = 10;
export const PLUGIN_MAX_TASK_TEMPLATES = 10;

export const PluginSkillId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits or "-" (2 to 32)');

/** instructions:包内 markdown 文件的相对路径。 */
export const PluginSkillInstructions = z
    .string()
    .min(1)
    .max(200)
    .refine(
        (path) => isPackagePath(path) && /\.md$/.test(path),
        'must be a relative path inside the package ending in .md',
    );

/** 运行控制工具:不由 Skill 决定,`toolSet` 不能列出(ADR 0048 第 1、6 节)。 */
const RUN_CONTROL = ['skill', 'tools', 'delegate'];

/** 工具集条目的第一段(组名);`plugin.x.y` / `mcp.x.y` 这类返回前两段。 */
function headOf(entry: string): string {
    return entry.split('.')[0] ?? entry;
}

/**
 * Skill `toolSet` 一项的问题(ADR 0048 第 1 节):不能列运行控制工具、MCP 工具或别的插件的工具;
 * 纯指令插件没有自己的工具,也不能列 `plugin.<自己>.`。没有问题时返回 null。
 */
export function skillToolSetProblem(entry: string, pluginId: string, hasEntry: boolean): string | null {
    // 工具名都是小写:大小写变体(`Skill.use`、`MCP.x`)匹配不到任何工具,只会是死条目,一律拒绝
    if (entry !== entry.toLowerCase()) return `"${entry}": skill tool sets must be lower case`;
    const head = headOf(entry);
    if (RUN_CONTROL.includes(head)) return `"${entry}" is a run-control tool and cannot be listed by a skill`;
    if (head === 'mcp')
        return `"${entry}" is an MCP tool; skills can only list core tools and their own plugin's tools`;
    if (head === 'plugin') {
        const owner = entry.split('.')[1];
        if (owner !== pluginId) return `"${entry}" belongs to another plugin`;
        if (!hasEntry) return `"${entry}": a plugin without "entry" has no tools of its own`;
    }
    return null;
}

/** Skill 的任务模板:插件模板加可选的 `toolSet`(写进所建任务的 `policy.toolSet`,必须在 Skill 的 `toolSet` 之内)。 */
export const PluginSkillTaskTemplate = PluginTaskTemplate.extend({
    toolSet: z
        .array(AgentToolSetEntry)
        .min(1)
        .max(30)
        .refine((set) => unique(set, (e) => e), 'duplicate tool')
        .optional(),
});
export type PluginSkillTaskTemplate = z.infer<typeof PluginSkillTaskTemplate>;

export const PluginSkill = z
    .strictObject({
        id: PluginSkillId,
        name: pluginText(64),
        /** 给模型看的一句话,写清什么时候用;出现在系统提示的 Skill 目录里。 */
        description: z.string().trim().min(1).max(200),
        instructions: PluginSkillInstructions,
        toolSet: z
            .array(AgentToolSetEntry)
            .min(1)
            .max(32)
            .refine((set) => unique(set, (e) => e), 'duplicate tool'),
        taskTemplates: z.array(PluginSkillTaskTemplate).max(PLUGIN_MAX_TASK_TEMPLATES).optional(),
    })
    .superRefine((skill, ctx) => {
        (skill.taskTemplates ?? []).forEach((template, i) => {
            if (template.toolSet && !toolSetWithin(template.toolSet, skill.toolSet)) {
                ctx.addIssue({
                    code: 'custom',
                    message: "the template's toolSet must stay within the skill's toolSet",
                    path: ['taskTemplates', i, 'toolSet'],
                });
            }
        });
    });
export type PluginSkill = z.infer<typeof PluginSkill>;

/** 变现预留(ADR 0040 第 10 节):M7 只接受免费插件。 */
export const PluginLicensing = z.strictObject({ model: z.literal('free') });

const SPDX_TOKEN = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*\+?|LicenseRef-[A-Za-z0-9.-]+)$/;

/** SPDX 表达式的形状检查(标识符、AND / OR / WITH、括号);不核对标识符是否在 SPDX 列表里。 */
export function isSpdxExpression(text: string): boolean {
    if (text.length === 0 || text.length > 128) return false;
    const tokens = text
        .replace(/([()])/g, ' $1 ')
        .split(/\s+/)
        .filter(Boolean);
    let depth = 0;
    let expectOperand = true;
    for (const token of tokens) {
        if (token === '(') {
            if (!expectOperand) return false;
            depth++;
        } else if (token === ')') {
            if (expectOperand || depth === 0) return false;
            depth--;
        } else if (token === 'AND' || token === 'OR' || token === 'WITH') {
            if (expectOperand) return false;
            expectOperand = true;
        } else {
            if (!expectOperand || !SPDX_TOKEN.test(token)) return false;
            expectOperand = false;
        }
    }
    return depth === 0 && !expectOperand;
}

const License = z.string().refine(isSpdxExpression, 'must be an SPDX license expression');
const Homepage = z
    .string()
    .max(500)
    .refine((value) => {
        try {
            return new URL(value).protocol === 'https:';
        } catch {
            return false;
        }
    }, 'must be an https:// URL');

// ───────────────────────── plugin.json ─────────────────────────

export const PluginManifest = z
    .strictObject({
        manifestVersion: z.literal(1),
        id: PluginId,
        version: PluginVersion,
        name: pluginText(64),
        description: pluginText(500),
        author: z.string().min(1).max(128),
        license: License,
        homepage: Homepage.optional(),
        engines: z.strictObject({ fatcat: PluginEngineRange }),
        /** 省略时是纯指令插件(ADR 0048 第 2 节):不起进程,只提供 Skill。 */
        entry: PluginEntry.optional(),
        permissions: PluginPermissions,
        settings: PluginSettings.optional(),
        taskTemplates: z.array(PluginTaskTemplate).max(PLUGIN_MAX_TASK_TEMPLATES).optional(),
        skills: z
            .array(PluginSkill)
            .min(1)
            .max(PLUGIN_MAX_SKILLS)
            .refine((skills) => unique(skills, (s) => s.id), 'duplicate skill id')
            .optional(),
        licensing: PluginLicensing.optional(),
    })
    .superRefine((manifest, ctx) => {
        const issue = (message: string, path: (string | number)[]): void => {
            ctx.addIssue({ code: 'custom', message, path });
        };
        const hasEntry = manifest.entry !== undefined;
        const skills = manifest.skills ?? [];
        if (!hasEntry) {
            if (skills.length === 0) issue('a plugin without "entry" must declare at least one skill', ['skills']);
            const { tools, net, secrets, items } = manifest.permissions;
            if (tools.length > 0) issue('a plugin without "entry" cannot declare tools', ['permissions', 'tools']);
            if (net.length > 0) issue('a plugin without "entry" cannot declare network access', ['permissions', 'net']);
            if (secrets.length > 0)
                issue('a plugin without "entry" cannot declare secrets', ['permissions', 'secrets']);
            if (items !== undefined) issue('a plugin without "entry" cannot declare items', ['permissions', 'items']);
            if (manifest.settings !== undefined)
                issue('a plugin without "entry" cannot declare settings', ['settings']);
        }
        if (!hasEntry || manifest.skills !== undefined) {
            const range = parseEngineRange(manifest.engines.fatcat);
            const floor = parseSemver(PLUGIN_SKILLS_MIN_CORE);
            if (range && floor && compareSemver(range.min, floor) < 0) {
                issue(`plugins with skills need engines.fatcat >=${PLUGIN_SKILLS_MIN_CORE}`, ['engines', 'fatcat']);
            }
        }
        const ownTools = new Set(manifest.permissions.tools.map((t) => t.name));
        let templates = manifest.taskTemplates?.length ?? 0;
        skills.forEach((skill, s) => {
            templates += skill.taskTemplates?.length ?? 0;
            skill.toolSet.forEach((entry, e) => {
                const problem = skillToolSetProblem(entry, manifest.id, hasEntry);
                if (problem) return issue(problem, ['skills', s, 'toolSet', e]);
                // 精确引用自己的工具时,工具必须在 permissions.tools 里声明过
                const parts = entry.split('.');
                if (parts[0] === 'plugin' && parts.length === 3 && parts[2] !== '' && !ownTools.has(parts[2]!)) {
                    issue(`"${entry}" is not declared in permissions.tools`, ['skills', s, 'toolSet', e]);
                }
            });
        });
        if (templates > PLUGIN_MAX_TASK_TEMPLATES) {
            issue(`at most ${PLUGIN_MAX_TASK_TEMPLATES} task templates in total (plugin and skills)`, [
                'taskTemplates',
            ]);
        }
    });
export type PluginManifest = z.infer<typeof PluginManifest>;

export interface PluginManifestIssue {
    path: string;
    message: string;
}

export type PluginManifestResult =
    | { ok: true; manifest: PluginManifest }
    | { ok: false; error: 'too_large' | 'invalid_json' | 'invalid_manifest'; issues: PluginManifestIssue[] };

/** 去掉所有以 `x-` 开头的字段(清单里只有它们可以出现在 schema 之外)。 */
function stripExtensions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripExtensions);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            if (!key.startsWith('x-')) out[key] = stripExtensions(inner);
        }
        return out;
    }
    return value;
}

function issuesOf(error: z.ZodError): PluginManifestIssue[] {
    return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** 校验一份已经解析的 JSON 值。 */
export function validatePluginManifest(value: unknown): PluginManifestResult {
    const parsed = PluginManifest.safeParse(stripExtensions(value));
    if (parsed.success) return { ok: true, manifest: parsed.data };
    return { ok: false, error: 'invalid_manifest', issues: issuesOf(parsed.error) };
}

/** 从 plugin.json 的原始内容校验:先查字节数上限(64 KiB),再解析 JSON,再过 schema。 */
export function parsePluginManifest(raw: string | Uint8Array): PluginManifestResult {
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    if (bytes.byteLength > PLUGIN_MANIFEST_MAX_BYTES) {
        return { ok: false, error: 'too_large', issues: [{ path: '', message: 'plugin.json is larger than 64 KiB' }] };
    }
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
        return {
            ok: false,
            error: 'invalid_json',
            issues: [{ path: '', message: error instanceof Error ? error.message : 'invalid JSON' }],
        };
    }
    return validatePluginManifest(value);
}

// ───────────────────────── 市场索引(ADR 0040 第 5.2 节) ─────────────────────────

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex digits');

export const PluginIndexVersion = z
    .strictObject({
        version: PluginVersion,
        engines: z.strictObject({ fatcat: PluginEngineRange }),
        url: z
            .string()
            .max(1000)
            .refine((value) => {
                try {
                    return new URL(value).protocol === 'https:';
                } catch {
                    return false;
                }
            }, 'must be an https:// URL'),
        size: z.number().int().min(1).max(PLUGIN_PACKAGE_MAX_BYTES),
        sha256: Sha256,
        permissions: PluginPermissions,
        publishedAt: IsoDateTime,
        yanked: z.boolean().default(false),
        yankedReason: z.string().max(500).nullable().default(null),
        /**
         * 纯指令插件(清单没有 `entry`,不起进程,ADR 0048 第 2、9 节);市场页据此标「纯指令」。
         * 索引仓库 CI 核对它与包内清单一致;旧索引没有这个字段时按 false 处理。
         */
        instructionOnly: z.boolean().default(false),
        /** 预留的作者级签名;M7 忽略。 */
        signatures: z.array(z.unknown()).optional(),
    })
    .refine((v) => !v.yanked || (v.yankedReason !== null && v.yankedReason.length > 0), {
        message: 'a yanked version needs a yankedReason',
        path: ['yankedReason'],
    });
export type PluginIndexVersion = z.infer<typeof PluginIndexVersion>;

/** 索引条目里一个 Skill 的摘要(ADR 0048 第 9 节):市场页展示用,内容与最新版本清单里的 Skill 一致。 */
export const PluginIndexSkill = z.strictObject({
    id: PluginSkillId,
    description: z.string().trim().min(1).max(200),
});
export type PluginIndexSkill = z.infer<typeof PluginIndexSkill>;

export const PluginIndexEntry = z.strictObject({
    id: PluginId,
    name: pluginText(64),
    description: pluginText(500),
    author: z.string().min(1).max(128),
    license: License,
    homepage: Homepage.optional(),
    versions: z
        .array(PluginIndexVersion)
        .min(1)
        .max(200)
        .refine((versions) => unique(versions, (v) => v.version), 'duplicate version'),
    licensing: PluginLicensing.optional(),
    /** 最新版本带的 Skill(可选,旧索引没有);索引仓库 CI 核对它与最新版本的清单一致。 */
    skills: z
        .array(PluginIndexSkill)
        .max(PLUGIN_MAX_SKILLS)
        .refine((skills) => unique(skills, (s) => s.id), 'duplicate skill id')
        .optional(),
});
export type PluginIndexEntry = z.infer<typeof PluginIndexEntry>;

const DownloadHost = z.string().refine((host) => {
    const parsed = parseDomainScope(host);
    return 'ok' in parsed && parsed.ok === host && !host.startsWith('*.');
}, 'must be a plain lowercase host name');

export const PluginIndex = z
    .strictObject({
        formatVersion: z.literal(1),
        market: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        /** 单调递增;客户端拒绝比缓存更小的值(防回滚)。 */
        serial: z.number().int().min(0),
        generatedAt: IsoDateTime,
        expiresAt: IsoDateTime,
        downloadHosts: z.array(DownloadHost).min(1).max(10),
        plugins: z
            .array(PluginIndexEntry)
            .max(5000)
            .refine((plugins) => unique(plugins, (p) => p.id), 'duplicate plugin id'),
    })
    .superRefine((index, ctx) => {
        index.plugins.forEach((plugin, p) =>
            plugin.versions.forEach((version, v) => {
                if (!index.downloadHosts.includes(new URL(version.url).hostname)) {
                    ctx.addIssue({
                        code: 'custom',
                        message: 'the download host is not listed in downloadHosts',
                        path: ['plugins', p, 'versions', v, 'url'],
                    });
                }
            }),
        );
    });
export type PluginIndex = z.infer<typeof PluginIndex>;

// ───────────────────────── fatcat/* 扩展消息(ADR 0040 第 1、3.3 节) ─────────────────────────

/** 同一条 stdio 连接上自定义的 JSON-RPC 方法;表外的方法一律回「方法不存在」。 */
export const FATCAT_METHODS = {
    /** 宿主 → 插件 */
    itemsRoots: 'fatcat/items.roots',
    itemsChildren: 'fatcat/items.children',
    itemsOpen: 'fatcat/items.open',
    /** 插件 → 宿主 */
    netFetch: 'fatcat/net.fetch',
    itemsUpsert: 'fatcat/items.upsert',
    log: 'fatcat/log',
    heartbeat: 'fatcat/heartbeat',
} as const;
export type FatcatMethod = (typeof FATCAT_METHODS)[keyof typeof FATCAT_METHODS];

/** 插件请求被拒绝时的 JSON-RPC 错误(`data.code` 为字符串码)。 */
export const PLUGIN_RPC_ERRORS = {
    method_not_found: -32601,
    invalid_params: -32602,
    permission_denied: -32001,
    quota_exceeded: -32002,
    fetch_failed: -32003,
} as const;
export type PluginRpcErrorCode = keyof typeof PLUGIN_RPC_ERRORS;

const ItemLocalId = z.string().min(1).max(200);
const MetaRecord = z
    .record(z.string(), z.unknown())
    .refine(
        (meta) => new TextEncoder().encode(JSON.stringify(meta)).byteLength <= PLUGIN_ITEM_META_MAX_BYTES,
        'meta is larger than 8 KiB',
    );

/** 插件提供的一个知识地图节点。`id` 是插件自己的编号,宿主存为 `plugin:<插件 id>:<id>`。 */
export const PluginItemNode = z.strictObject({
    id: ItemLocalId,
    type: PluginItemCategory.shape.type,
    title: z.string().min(1).max(200),
    summary: z.string().max(500).optional(),
    hasChildren: z.boolean().default(false),
    meta: MetaRecord.optional(),
});
export type PluginItemNode = z.infer<typeof PluginItemNode>;

export const ItemsRootsParams = z.strictObject({ type: PluginItemCategory.shape.type.optional() });
export const ItemsChildrenParams = z.strictObject({
    /** 父节点所属的类别,宿主据此找到对应的提供者。 */
    type: PluginItemCategory.shape.type,
    parentId: ItemLocalId,
    cursor: z.string().max(500).optional(),
});
export const ItemsListResult = z.strictObject({
    items: z.array(PluginItemNode).max(500),
    nextCursor: z.string().max(500).optional(),
});
export const ItemsOpenParams = z.strictObject({ type: PluginItemCategory.shape.type, id: ItemLocalId });
export const ItemsOpenResult = z.strictObject({
    title: z.string().min(1).max(200),
    /** 纯文本;宿主按不可信内容处理。 */
    content: z.string().max(200_000),
    url: Homepage.optional(),
});

export const ItemsUpsertParams = z.strictObject({
    items: z
        .array(PluginItemNode.extend({ parentId: ItemLocalId.optional() }))
        .min(1)
        .max(500),
});
export const ItemsUpsertResult = z.strictObject({ upserted: z.number().int().min(0) });

const FORBIDDEN_FETCH_HEADERS = /^(?:host|cookie|proxy-.*)$/i;

export const NetFetchParams = z
    .strictObject({
        url: z
            .string()
            .max(2000)
            .refine((value) => {
                try {
                    return new URL(value).protocol === 'https:';
                } catch {
                    return false;
                }
            }, 'only https: URLs are allowed'),
        method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
        headers: z
            .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(2000))
            .refine((headers) => Object.keys(headers).length <= 30, 'at most 30 headers')
            .refine((headers) => Object.keys(headers).every((name) => !FORBIDDEN_FETCH_HEADERS.test(name)), {
                message: 'Host, Cookie and Proxy-* headers are not allowed',
            })
            .optional(),
        body: z
            .string()
            .max(1024 * 1024)
            .optional(),
    })
    .refine((p) => p.body === undefined || p.method === 'POST', {
        message: 'only POST requests may have a body',
        path: ['body'],
    });
export type NetFetchParams = z.input<typeof NetFetchParams>;

export const NetFetchResult = z.strictObject({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
    bodyEncoding: z.enum(['utf8', 'base64']),
    truncated: z.boolean(),
});
export type NetFetchResult = z.infer<typeof NetFetchResult>;

export const LogParams = z.strictObject({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    /** 宿主截断到 1,000 字符;这里只防极端大的消息。 */
    message: z.string().max(100_000),
    fields: z.record(z.string(), z.unknown()).optional(),
});
export type LogParams = z.infer<typeof LogParams>;

export const HeartbeatParams = z.strictObject({ rss: z.number().int().min(0) });
export type HeartbeatParams = z.infer<typeof HeartbeatParams>;

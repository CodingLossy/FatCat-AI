#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 官方索引仓库(CodingLossy/fatcat-plugins)的 CI 检查(ADR 0040 第 5.2 节),合并前必跑。CI 不接触签名私钥。
//
//   node scripts/plugins/check-index.mjs --index index.json [--previous previous-index.json] [--core-version 1.1.0]
//
// 检查项:
//  1. index.json 通过 @fatcat-ai/shared 的 PluginIndex schema(与客户端用同一份),id 唯一、下载主机在 downloadHosts 里。
//  2. 与上一版比较:不许删除已有版本;已有版本的地址、大小、sha256、engines、权限、发布时间不得改动;
//     下架只能标 yanked: true 并写 yankedReason,不能取消下架;serial 不得变小。
//  3. 重新下载每个新增或修改的版本:大小与 sha256 与条目一致;用与客户端相同的 tar 读取器解包(符号链接、`..`、盘符、
//     保留名、压缩炸弹等一律拒绝);包内 plugin.json 通过清单 schema,id、版本与权限与条目一致;
//  4. 静态检查(第 3.4 节第 2 层):打包产物里不得出现加载被拒绝内置模块的写法(import / import() / require /
//     createRequire / getBuiltinModule,含 node: 前缀与 /promises)、process.binding、process.dlopen、eval / new Function。
//     只看字面量,不认普通字符串里的模块名;局限见 MODULE 模式上方的注释与 ADR 0040 第 3.4 节。
//  5. Skill(ADR 0048 第 9 节):`instructionOnly` 与包内清单是否有 `entry` 一致;没有下架的最新版本的 Skill 与条目的
//     `skills` 一致(条目只改 `skills`、或最新版本被下架时,也重新下载那个版本核对);Skill 的 description 与
//     instructions 做中英文话术初筛(要求跳过或绕过审批、读取或输出密钥、把对话或数据发到外部、忽略之前的指令)。
//     初筛只看关键词与模式,人工审核是最后一关;漏过的说明在运行时也拿不到任何额外权限(ADR 0048 第 4 节)。
// 需要先构建 packages/shared 与 packages/tools(`pnpm build`);索引仓库的工作流见 scripts/plugins/README.md。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 第 3.4 节预加载拒绝的内置模块(加上 module / wasi / v8 / tty,见 ADR PR 2b 注记)。 */
export const FORBIDDEN_MODULES = [
    'net',
    'tls',
    'http',
    'https',
    'http2',
    'dgram',
    'dns',
    'child_process',
    'worker_threads',
    'cluster',
    'inspector',
    'vm',
    'repl',
    'sqlite',
    'module',
    'wasi',
    'v8',
    'tty',
];

// 只认真正加载模块的写法,不认出现在普通字符串里的模块名(例如打包进来的 shared 里的 'net' / 'tls' 字样):
//   静态:`import x from 'm'`、`import 'm'`、`export ... from 'm'`
//   动态:`import('m')`、`require('m')`、`__require('m')`(esbuild 的垫片)、`process.getBuiltinModule('m')`、
//         `createRequire(...)('m')`
// 局限:只看字面量。拼接出来的名字、先把 createRequire 的结果存进变量再调用、把加载函数当参数传递,这里都识别不出来;
// 这些由运行时的预加载钩子和操作系统层拦截(第 3.4 节第 1、2 层),扫描只是上架前的一道初筛。
const MODULE_NAME = `(?:node:)?(?:${FORBIDDEN_MODULES.join('|')})(?:/promises)?`;
const QUOTED = `(['"\`])${MODULE_NAME}\\1`;
const LOAD_PATTERNS = [
    new RegExp(`\\b(?:from|import)\\s*${QUOTED}`),
    new RegExp(`\\b(?:import|(?:__)?require(?:\\.resolve)?|getBuiltinModule)\\s*\\(\\s*${QUOTED}`),
    new RegExp(`\\bcreateRequire\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*\\(\\s*${QUOTED}`),
];
const OTHER_PATTERNS = [
    [/\bprocess\s*\.\s*binding\b|\bprocess\s*\[\s*['"]binding['"]\s*\]/, 'process.binding'],
    [/\bprocess\s*\.\s*dlopen\b|\bprocess\s*\[\s*['"]dlopen['"]\s*\]/, 'process.dlopen'],
    [/\bprocess\s*\.\s*_linkedBinding\b/, 'process._linkedBinding'],
    [/\beval\s*\(/, 'eval()'],
    [/\b(?:new\s+)?Function\s*\(/, 'new Function()'],
];

/** 静态检查:返回每个命中项的描述;`files` 是 { path, text }。 */
export function staticScan(files) {
    const findings = [];
    for (const { path, text } of files) {
        const lines = text.split('\n');
        lines.forEach((line, i) => {
            for (const pattern of LOAD_PATTERNS) {
                const module = pattern.exec(line);
                if (module) {
                    findings.push(`${path}:${i + 1}: loads the forbidden module ${module[0]}`);
                    break;
                }
            }
            for (const [pattern, label] of OTHER_PATTERNS) {
                if (pattern.test(line)) findings.push(`${path}:${i + 1}: uses ${label}`);
            }
        });
    }
    return findings;
}

// Skill 说明的话术初筛(ADR 0048 第 9 节):命中任何一条就拦下,由人工确认后改写说明。宁可多报,不可漏报常见写法。
const INSTRUCTION_PATTERNS = [
    [
        /\b(?:skip|bypass|avoid|disable|ignore|circumvent|get around|work around)\b[^.\n]{0,40}\b(?:approvals?|confirmations?|approval cards?|permission prompts?)\b/i,
        'asks to skip or bypass approval',
    ],
    [
        /\bapprove\b[^.\n]{0,20}\b(?:automatically|by itself|on (?:its|your) own|everything|all)\b/i,
        'asks to approve automatically',
    ],
    [/\bauto[- ]?approv/i, 'asks to approve automatically'],
    [
        /\bwithout (?:asking|approval|confirmation|telling) (?:the )?(?:user|owner|them)?/i,
        'asks to act without asking the user',
    ],
    [/\bsecrets?\.ya?ml(?:\.enc|\.migrated)?\b|\bmaster[- ]key\b|\.env\b/i, 'mentions a secrets file'],
    [
        /\b(?:read|print|show|output|reveal|send|copy|dump|export|leak)\b[^.\n]{0,40}\b(?:secrets?|api[- ]?keys?|passwords?|tokens?|private keys?|credentials?|environment variables?)\b/i,
        'asks to read or output secrets',
    ],
    [
        /\b(?:send|post|upload|forward|exfiltrate|leak|transmit|copy)\b[^.\n]{0,60}\b(?:conversation|chat history|messages|memory|memories|files?|e-?mails?)\b[^.\n]{0,40}\b(?:to|into)\b[^.\n]{0,20}(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}\/)/i,
        'asks to send data to an outside address',
    ],
    [
        /\b(?:ignore|disregard|override|forget)\b[^.\n]{0,30}\b(?:previous|prior|system|your|all)\b[^.\n]{0,20}\b(?:instructions|rules|prompt)\b/i,
        'asks to ignore the system rules',
    ],
    // 中文写法:中文没有词边界,用字符匹配,中间最多隔 20 个字(不跨句号和换行)
    [
        /(?:跳过|绕过|绕开|无需|不需要|不用|免去|省略|关闭)[^。\n]{0,20}(?:审批|确认|授权|批准)|自动(?:通过|批准|确认|授权)/,
        'asks to skip or bypass approval',
    ],
    [
        /不(?:用|必|要|需要)[^。\n]{0,6}(?:询问|告诉|征求|通知|问)[^。\n]{0,6}(?:用户|业主|主人|对方)/,
        'asks to act without asking the user',
    ],
    [
        /(?:读取|读出|输出|打印|显示|发送|导出|泄露|复制|告诉)[^。\n]{0,20}(?:密钥|密码|令牌|凭据|凭证|私钥|API ?Key|环境变量)|(?:密钥|密码|令牌|凭据|凭证|私钥|API ?Key)[^。\n]{0,10}(?:打印|输出|显示|发送|导出|泄露|发给|贴)/i,
        'asks to read or output secrets',
    ],
    [
        /(?:(?:发送|上传|转发|同步|复制|发给)[^。\n]{0,20}(?:对话|聊天记录|消息|记忆|文件|邮件)|(?:对话|聊天记录|消息|记忆|文件|邮件)[^。\n]{0,20}(?:发送|上传|转发|同步|复制|发给))[^。\n]{0,20}(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}\/)/i,
        'asks to send data to an outside address',
    ],
    [
        /(?:忽略|无视|忘掉|忘记|不要理会)[^。\n]{0,10}(?:之前|上面|以上|前面|系统|所有|全部)[^。\n]{0,10}(?:指令|规则|提示|指示|要求)/,
        'asks to ignore the system rules',
    ],
];

/** Skill 说明与 description 的话术初筛;`files` 是 { path, text }。返回每个命中项的描述。 */
export function instructionScan(files) {
    const findings = [];
    for (const { path, text } of files) {
        text.split('\n').forEach((line, i) => {
            for (const [pattern, label] of INSTRUCTION_PATTERNS) {
                if (pattern.test(line)) findings.push(`${path}:${i + 1}: ${label}`);
            }
        });
    }
    return findings;
}

/** 包内清单的 Skill 要检查的文字:每个 description 和 instructions 文件(路径已由清单 schema 限定在包内)。 */
export function skillTexts(manifest, dir) {
    const out = [];
    (manifest.skills ?? []).forEach((skill, i) => {
        out.push({ path: `plugin.json skills.${i}.description`, text: skill.description });
        out.push({ path: skill.instructions, text: readFileSync(join(dir, skill.instructions), 'utf8') });
    });
    return out;
}

/** 递归规范化(对象键排序,数组按元素文本排序),用来比较两份权限清单。 */
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

const IMMUTABLE = ['url', 'size', 'sha256', 'publishedAt', 'instructionOnly'];

/** 与上一版索引比较(纯函数):返回问题列表,并列出需要重新下载核对的 { id, version }。 */
export function compareIndexes(previous, next) {
    const errors = [];
    if (previous === null) {
        return { errors, changed: next.plugins.flatMap((p) => p.versions.map((v) => ({ plugin: p, version: v }))) };
    }
    if (next.market !== previous.market) errors.push(`market changed from "${previous.market}" to "${next.market}"`);
    if (next.serial < previous.serial) errors.push(`serial went backwards (${previous.serial} -> ${next.serial})`);
    const changed = [];
    const nextById = new Map(next.plugins.map((p) => [p.id, p]));
    for (const old of previous.plugins) {
        const plugin = nextById.get(old.id);
        if (!plugin) {
            errors.push(`${old.id}: the plugin was removed; withdraw versions with yanked: true instead`);
            continue;
        }
        const versions = new Map(plugin.versions.map((v) => [v.version, v]));
        for (const oldVersion of old.versions) {
            const version = versions.get(oldVersion.version);
            const label = `${old.id}@${oldVersion.version}`;
            if (!version) {
                errors.push(`${label}: the version was removed; withdraw it with yanked: true instead`);
                continue;
            }
            for (const key of IMMUTABLE) {
                if (version[key] !== oldVersion[key]) errors.push(`${label}: ${key} must not change after publishing`);
            }
            if (canonical(version.engines) !== canonical(oldVersion.engines))
                errors.push(`${label}: engines must not change`);
            if (canonical(version.permissions) !== canonical(oldVersion.permissions)) {
                errors.push(`${label}: permissions must not change`);
            }
            if (oldVersion.yanked && !version.yanked) errors.push(`${label}: a withdrawn version cannot be restored`);
        }
    }
    const previousVersions = new Set(previous.plugins.flatMap((p) => p.versions.map((v) => `${p.id}@${v.version}`)));
    for (const plugin of next.plugins) {
        for (const version of plugin.versions) {
            if (!previousVersions.has(`${plugin.id}@${version.version}`)) changed.push({ plugin, version });
        }
    }
    if (
        next.serial === previous.serial &&
        (changed.length > 0 || canonical(next.plugins) !== canonical(previous.plugins))
    ) {
        errors.push('the index changed but serial did not increase');
    }
    return { errors, changed };
}

/** 默认的下载:只 https、主机在允许列表里、逐跳检查重定向、读到上限为止。 */
export async function downloadChecked(url, allowedHosts, maxBytes = PACKAGE_MAX_BYTES) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:') throw new Error(`${current}: only https is allowed`);
        if (!allowedHosts.includes(parsed.hostname)) throw new Error(`${parsed.hostname} is not in downloadHosts`);
        const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'fatcat-plugins-ci' } });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location'), current).href;
            continue;
        }
        if (res.status !== 200) throw new Error(`${current}: HTTP ${res.status}`);
        const chunks = [];
        let size = 0;
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > maxBytes) throw new Error(`${current}: larger than ${maxBytes} bytes`);
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
}

/** 列出目录下的 .js/.mjs/.cjs;符号链接与特殊文件不跟随、直接跳过。 */
export function listScripts(dir, base = dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listScripts(full, base));
        else if (entry.isFile() && /\.(c|m)?js$/.test(entry.name))
            out.push({
                path: full
                    .slice(base.length + 1)
                    .split(sep)
                    .join('/'),
                text: readFileSync(full, 'utf8'),
            });
    }
    return out;
}

/**
 * 条目的 `skills` 对应的版本:没有下架的最新版本(按语义化版本),也就是市场页默认展示的那个;
 * 全部下架时取最新版本。
 */
export function skillsReference(plugin, deps) {
    const parse = deps.parseSemver;
    const live = plugin.versions.filter((v) => !v.yanked);
    const pool = live.length > 0 ? live : plugin.versions;
    return pool.reduce((best, v) => (deps.compareSemver(parse(v.version), parse(best.version)) > 0 ? v : best));
}

const skillList = (skills) => canonical((skills ?? []).map((s) => ({ id: s.id, description: s.description })));

/**
 * 完整检查。`deps` 提供与客户端相同的实现:{ PluginIndex, extractTgz, validateStagedPackage, parseSemver, compareSemver };
 * `download(url, allowedHosts)` 默认真的下载,测试里可以替换。
 */
export async function checkIndex({
    indexBytes,
    previousBytes = null,
    deps,
    coreVersion = '1.1.0',
    download = downloadChecked,
}) {
    const errors = [];
    if (indexBytes.length > INDEX_MAX_BYTES) return { errors: ['index.json is larger than 4 MiB'], checked: [] };
    let raw;
    try {
        raw = JSON.parse(indexBytes.toString('utf8'));
    } catch {
        return { errors: ['index.json is not valid JSON'], checked: [] };
    }
    const parsed = deps.PluginIndex.safeParse(raw);
    if (!parsed.success) {
        return {
            errors: parsed.error.issues.map((i) => `index.json: ${i.path.join('.')}: ${i.message}`),
            checked: [],
        };
    }
    const next = parsed.data;
    let previous = null;
    if (previousBytes) {
        const prev = deps.PluginIndex.safeParse(JSON.parse(previousBytes.toString('utf8')));
        if (!prev.success) errors.push('the previous index.json does not match the schema; fix it first');
        else previous = prev.data;
    }
    if (Date.parse(next.expiresAt) <= Date.now()) errors.push('expiresAt is already in the past');
    if (Date.parse(next.expiresAt) <= Date.parse(next.generatedAt)) errors.push('expiresAt must be after generatedAt');
    const compared = compareIndexes(previous, next);
    errors.push(...compared.errors);
    // 条目的 skills 变了,或者对应的版本变了(例如最新版本被下架),没有新版本也要重新核对那个版本
    if (previous) {
        const before = new Map(previous.plugins.map((p) => [p.id, p]));
        for (const plugin of next.plugins) {
            const old = before.get(plugin.id);
            if (!old) continue;
            const reference = skillsReference(plugin, deps);
            const moved = skillsReference(old, deps).version !== reference.version;
            if (skillList(plugin.skills) === skillList(old.skills) && !moved) continue;
            if (!compared.changed.some((c) => c.plugin.id === plugin.id && c.version.version === reference.version)) {
                compared.changed.push({ plugin, version: reference });
            }
        }
    }

    const checked = [];
    for (const { plugin, version } of compared.changed) {
        const label = `${plugin.id}@${version.version}`;
        checked.push(label);
        let dir = null;
        try {
            const bytes = await download(version.url, next.downloadHosts);
            if (bytes.length !== version.size) {
                errors.push(`${label}: downloaded ${bytes.length} bytes, the index says ${version.size}`);
            }
            const digest = createHash('sha256').update(bytes).digest('hex');
            if (digest !== version.sha256) {
                errors.push(`${label}: sha256 is ${digest}, the index says ${version.sha256}`);
                continue;
            }
            dir = mkdtempSync(join(tmpdir(), 'fatcat-index-'));
            const target = join(dir, 'pkg');
            mkdirSync(target);
            await deps.extractTgz(bytes, target);
            const { manifest } = deps.validateStagedPackage(target, coreVersion);
            if (manifest.id !== plugin.id) errors.push(`${label}: plugin.json id is "${manifest.id}"`);
            if (manifest.version !== version.version)
                errors.push(`${label}: plugin.json version is "${manifest.version}"`);
            if (canonical(manifest.permissions) !== canonical(version.permissions)) {
                errors.push(`${label}: plugin.json permissions do not match the index entry`);
            }
            for (const finding of staticScan(listScripts(target))) errors.push(`${label}: ${finding}`);
            const instructionOnly = manifest.entry === undefined;
            if (instructionOnly !== version.instructionOnly) {
                errors.push(
                    `${label}: instructionOnly must be ${instructionOnly} (plugin.json ${instructionOnly ? 'has no' : 'has an'} entry)`,
                );
            }
            if (skillsReference(plugin, deps).version === version.version) {
                if (skillList(plugin.skills) !== skillList(manifest.skills)) {
                    errors.push(`${label}: skills do not match the skills in plugin.json`);
                }
            }
            for (const finding of instructionScan(skillTexts(manifest, target))) {
                errors.push(`${label}: ${finding} (rewrite the skill text; a maintainer reviews it either way)`);
            }
        } catch (error) {
            errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
        }
    }
    return { errors, checked };
}

async function loadDeps() {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const load = (rel) => import(pathToFileURL(join(root, rel)).href);
    try {
        const shared = await load('packages/shared/dist/index.js');
        const market = await load('packages/tools/dist/plugins/market-entry.js');
        return {
            PluginIndex: shared.PluginIndex,
            parseSemver: shared.parseSemver,
            compareSemver: shared.compareSemver,
            extractTgz: market.extractTgz,
            validateStagedPackage: market.validateStagedPackage,
        };
    } catch (error) {
        throw new Error(`build the packages first (pnpm build): ${error instanceof Error ? error.message : error}`, {
            cause: error,
        });
    }
}

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (!['--index', '--previous', '--core-version'].includes(key) || argv[i + 1] === undefined) {
            throw new Error(
                'usage: check-index.mjs --index index.json [--previous previous.json] [--core-version 1.1.0]',
            );
        }
        out[key.slice(2)] = argv[i + 1];
    }
    if (!out.index) throw new Error('--index is required');
    return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const a = args(process.argv.slice(2));
        const { errors, checked } = await checkIndex({
            indexBytes: readFileSync(a.index),
            previousBytes: a.previous ? readFileSync(a.previous) : null,
            deps: await loadDeps(),
            ...(a['core-version'] ? { coreVersion: a['core-version'] } : {}),
        });
        for (const label of checked) console.log(`checked ${label}`);
        if (errors.length > 0) {
            for (const error of errors) console.error(`error: ${error}`);
            process.exit(1);
        }
        console.log(`index OK (${checked.length} new version(s) re-downloaded and verified)`);
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    }
}

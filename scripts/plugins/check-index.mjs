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
//  4. 静态检查(第 3.4 节第 2 层):打包产物里不得出现被拒绝的内置模块名、process.binding、process.dlopen、eval / new Function。
// 需要先构建 packages/shared 与 packages/tools(`pnpm build`);索引仓库的工作流见 scripts/plugins/README.md。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const MODULE_PATTERN = new RegExp(`['"\`](?:node:)?(?:${FORBIDDEN_MODULES.join('|')})(?:/promises)?['"\`]`);
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
            const module = MODULE_PATTERN.exec(line);
            if (module) findings.push(`${path}:${i + 1}: mentions the forbidden module ${module[0]}`);
            for (const [pattern, label] of OTHER_PATTERNS) {
                if (pattern.test(line)) findings.push(`${path}:${i + 1}: uses ${label}`);
            }
        });
    }
    return findings;
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

const IMMUTABLE = ['url', 'size', 'sha256', 'publishedAt'];

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

function listScripts(dir, base = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listScripts(full, base));
        else if (/\.(c|m)?js$/.test(name))
            out.push({ path: full.slice(base.length + 1), text: readFileSync(full, 'utf8') });
    }
    return out;
}

/**
 * 完整检查。`deps` 提供与客户端相同的实现:{ PluginIndex, extractTgz, validateStagedPackage };
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

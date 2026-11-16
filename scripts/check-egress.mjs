// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 外连登记表检查(ADR 0028 第 3 节):静态扫描生产代码里使用网络 API 的文件,
// 每个命中的文件必须登记在 scripts/egress-registry.json;登记了但代码里没有的条目也失败;
// kind 为 fixed 的条目,其 listedAs 必须能在 apps/server/src/egress.ts 找到同名符号。不允许通配符。
// 这是静态文本扫描,会有误报:误报用 kind: local-only 加理由登记,不加通配符。
// 运行:node scripts/check-egress.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KINDS = ['fixed', 'dynamic', 'local-only'];
export const EGRESS_SOURCE = 'apps/server/src/egress.ts';
const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'e2e', 'fixtures', '.turbo']);
const SKIP_FILE = /\.(test|eval|perf)\.[cm]?[jt]sx?$|\.d\.ts$|(^|\/)(testing|test-helpers)\.ts$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** 网络 API 的特征(ADR 0028 第 3 节);fetch 也包括 `?? fetch` 与 globalThis.fetch 这类未带括号的取用。 */
const PATTERNS = [
    /(?<![.\w])fetch\(/,
    /\bglobalThis\.fetch\b/,
    /\?\?\s*fetch\b/,
    /['"]node:(?:net|tls|http|https|dgram)['"]/,
    /new\s+WebSocket\(/,
    /['"]undici['"]/,
    // 邮件客户端库自己开 TCP 连接
    /['"](?:imapflow|nodemailer)(?:\/[^'"]*)?['"]/,
];

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (SOURCE_FILE.test(name) && !SKIP_FILE.test(full.replaceAll('\\', '/'))) out.push(full);
    }
}

/** 只看 apps/*\/src 与 packages/*\/src 下的生产代码。 */
function productionFiles(root) {
    const files = [];
    for (const top of SCAN_ROOTS) {
        const topDir = join(root, top);
        if (!existsSync(topDir)) continue;
        for (const pkg of readdirSync(topDir)) {
            const src = join(topDir, pkg, 'src');
            if (existsSync(src) && statSync(src).isDirectory()) walk(src, files);
        }
    }
    return files.map((f) => relative(root, f).replaceAll('\\', '/')).sort();
}

function usesNetwork(text) {
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        if (PATTERNS.some((p) => p.test(line))) return true;
    }
    return false;
}

function hasSymbol(source, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:function|const|let|class|interface|type)\\s+${escaped}\\b`).test(source);
}

/** 返回错误列表;root 是仓库根目录(测试里是夹具目录)。 */
export function checkEgress(root, registryPath = join(root, 'scripts', 'egress-registry.json')) {
    const errors = [];
    let registry;
    try {
        registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    } catch (e) {
        return [`cannot read ${relative(root, registryPath)}: ${e.message}`];
    }
    if (!Array.isArray(registry)) return ['the registry must be a JSON array'];

    const egressPath = join(root, EGRESS_SOURCE);
    const egressSource = existsSync(egressPath) ? readFileSync(egressPath, 'utf8') : '';
    const registered = new Map();
    for (const [i, entry] of registry.entries()) {
        const where = `registry[${i}]`;
        if (typeof entry?.file !== 'string' || entry.file === '') {
            errors.push(`${where}: "file" is required`);
            continue;
        }
        if (/[*?[\]{}]/.test(entry.file)) errors.push(`${entry.file}: wildcards are not allowed`);
        if (registered.has(entry.file)) errors.push(`${entry.file}: registered twice`);
        registered.set(entry.file, entry);
        if (!KINDS.includes(entry.kind)) errors.push(`${entry.file}: "kind" must be one of ${KINDS.join(', ')}`);
        for (const key of ['listedAs', 'reason']) {
            const v = entry[key];
            const ok = Array.isArray(v)
                ? v.length > 0 && v.every((x) => typeof x === 'string' && x !== '')
                : typeof v === 'string' && v !== '';
            if (!ok) errors.push(`${entry.file}: "${key}" is required`);
        }
        if (entry.kind === 'fixed') {
            const names = Array.isArray(entry.listedAs) ? entry.listedAs : [entry.listedAs];
            for (const name of names) {
                if (typeof name === 'string' && name !== '' && !hasSymbol(egressSource, name)) {
                    errors.push(`${entry.file}: listedAs "${name}" is not defined in ${EGRESS_SOURCE}`);
                }
            }
        }
    }

    const hits = productionFiles(root).filter((f) => usesNetwork(readFileSync(join(root, f), 'utf8')));
    for (const file of hits) {
        if (!registered.has(file)) errors.push(`${file}: uses a network API but is not in the egress registry`);
    }
    for (const file of registered.keys()) {
        if (!hits.includes(file)) errors.push(`${file}: registered, but no network API is used there any more`);
    }
    return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const errors = checkEgress(root);
    if (errors.length > 0) {
        console.error('check:egress failed:');
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log('check:egress ok');
}

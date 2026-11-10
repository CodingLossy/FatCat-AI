// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 依赖许可证白名单与遥测包黑名单检查(计划第 10、13、15.2 节)。
// 第三方 copyleft 依赖会使商业许可版无法发布,因此一律拒绝。
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
    'MIT',
    'MIT-0',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'CC-BY-4.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'Zlib',
]);
/**
 * 人工核对过的例外:package.json 没有写合法 SPDX 标识的包,写明核对结果。
 * - @modelcontextprotocol/server-filesystem:「SEE LICENSE IN LICENSE」,仓库 LICENSE 为 MIT 与 Apache-2.0
 *   (许可证迁移期),只作为 MCP 客户端集成测试用的官方示例服务器(ADR 0013 第 1 节)。
 */
const REVIEWED = new Map([
    ['@modelcontextprotocol/server-filesystem', 'MIT OR Apache-2.0'],
    // sqlite-vec 的 package.json 写的是「MIT OR Apache」(不是合法的 SPDX);上游仓库为 MIT 与 Apache-2.0 双许可(ADR 0014)
    ['sqlite-vec', 'MIT OR Apache-2.0'],
    ['sqlite-vec-darwin-arm64', 'MIT OR Apache-2.0'],
    ['sqlite-vec-darwin-x64', 'MIT OR Apache-2.0'],
    ['sqlite-vec-linux-arm64', 'MIT OR Apache-2.0'],
    ['sqlite-vec-linux-x64', 'MIT OR Apache-2.0'],
    ['sqlite-vec-windows-x64', 'MIT OR Apache-2.0'],
]);
/** 仅允许以未修改库形式使用,输出警告供人工确认。 */
const WEAK_COPYLEFT = new Set(['MPL-2.0']);

const TELEMETRY = [
    /^@sentry\//,
    /^posthog/,
    /^@segment\//,
    /^analytics-node$/,
    /^mixpanel/,
    /^@amplitude\//,
    /^@datadog\//,
    /^newrelic$/,
    /^@bugsnag\//,
    /^rollbar$/,
    /^applicationinsights$/,
    /^@opentelemetry\/exporter-/,
];

/** 简化的 SPDX 表达式判断:OR 任一允许即可,AND 需全部允许。 */
function evaluate(expr, allowed) {
    const clean = expr.replace(/[()]/g, ' ').trim();
    if (/\sOR\s/.test(clean)) return clean.split(/\s+OR\s+/).some((e) => evaluate(e, allowed));
    if (/\sAND\s/.test(clean)) return clean.split(/\s+AND\s+/).every((e) => evaluate(e, allowed));
    return allowed.has(clean);
}

const raw = execSync('pnpm licenses list --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw);

const errors = [];
const warnings = [];
let count = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const pkg of pkgs) {
        count++;
        const id = `${pkg.name}@${pkg.versions?.join(',') ?? pkg.version}`;
        if (TELEMETRY.some((re) => re.test(pkg.name))) errors.push(`${id}: 禁止的遥测依赖`);
        if (evaluate(REVIEWED.get(pkg.name) ?? license, ALLOWED)) continue;
        if (evaluate(license, new Set([...ALLOWED, ...WEAK_COPYLEFT]))) {
            warnings.push(`${id}: ${license}(仅允许以未修改库形式使用)`);
        } else {
            errors.push(`${id}: 许可证 "${license}" 不在白名单中`);
        }
    }
}

if (warnings.length > 0) console.warn(warnings.join('\n'));
if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error(`\n依赖许可证检查失败:${errors.length} 处问题。白名单见 CONTRIBUTING.md 第 5 节`);
    process.exit(1);
}
console.log(`依赖许可证检查通过(${count} 个包)`);

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 内置 Skill(ADR 0048 第 5 节):把 packages/tools/src/skills/<id>/ 下的 skill.json 与 instructions.md
// 写进 packages/tools/src/skills/generated.ts。源文件是那两个文件;生成的模块让构建、Docker 镜像和桌面版的
// 单文件 sidecar 都不用在运行时找文件。改了源文件后运行 `pnpm gen:skills`;packages/tools 的单测会核对两边一致。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath:Windows 上 URL 的 pathname 是 `/E:/...`,中文或空格还会被百分号编码
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'packages/tools/src/skills');
const out = join(dir, 'generated.ts');

const skills = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((id) => {
        const manifest = JSON.parse(readFileSync(join(dir, id, 'skill.json'), 'utf8'));
        const instructions = readFileSync(join(dir, id, manifest.instructions), 'utf8');
        return { manifest, instructions };
    });

const body = [
    // 拆开写,免得 REUSE 把这一行当成本脚本自己的许可证声明
    `// SPDX${'-'}License-Identifier: AGPL-3.0-only`,
    '// Copyright (C) 2026 尹绪柏 (Theodore Yin)',
    '',
    '// 由 scripts/gen-builtin-skills.mjs 从 skills/<id>/skill.json 与 instructions.md 生成,不要手改。',
    '',
    `export const BUILTIN_SKILL_SOURCES = ${JSON.stringify(skills, null, 4)} as const;`,
    '',
].join('\n');
writeFileSync(out, body);
// 直接用 node 跑 prettier 的入口:node_modules/.bin 下的 shim 在 Windows 上是 .cmd,execFileSync 不能直接运行
const prettier = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');
execFileSync(process.execPath, [prettier, '--write', out], { stdio: 'ignore' });
console.log(`wrote ${skills.length} built-in skill(s) to ${out}`);

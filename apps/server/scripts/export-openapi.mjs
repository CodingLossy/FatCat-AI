// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 导出 openapi/v1.json(先 pnpm build)。CI 中重新导出并要求与仓库中的文件一致,作为以后 oasdiff 破坏性变更检测的基线。
import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../dist/openapi.js';

const doc = await buildOpenApiDocument();
const out = new URL('../openapi/v1.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument', () => {
    it('与仓库中的 openapi/v1.json 一致(CI 导出检查的同一份文档)', async () => {
        const doc = (await buildOpenApiDocument()) as { openapi: string; paths: Record<string, unknown> };
        expect(doc.openapi).toBe('3.1.0');
        expect(Object.keys(doc.paths)).toContain('/api/v1/settings');
        const committed: unknown = JSON.parse(readFileSync(new URL('../openapi/v1.json', import.meta.url), 'utf8'));
        expect(doc).toEqual(committed);
    });
});

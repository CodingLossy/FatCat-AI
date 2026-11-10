// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { MetaResponseSchema, PROTOCOL_VERSION } from './meta.js';

describe('MetaResponseSchema', () => {
    it('接受合法的 meta 响应', () => {
        const meta = {
            name: 'FatCat-AI',
            serverVersion: '0.0.0',
            protocolVersion: PROTOCOL_VERSION,
            license: 'AGPL-3.0-only',
            sourceUrl: null,
            capabilities: [],
        };
        expect(MetaResponseSchema.parse(meta)).toEqual(meta);
    });

    it('拒绝非法的 sourceUrl', () => {
        const result = MetaResponseSchema.safeParse({
            name: 'FatCat-AI',
            serverVersion: '0.0.0',
            protocolVersion: 1,
            license: 'AGPL-3.0-only',
            sourceUrl: 'not a url',
            capabilities: [],
        });
        expect(result.success).toBe(false);
    });
});

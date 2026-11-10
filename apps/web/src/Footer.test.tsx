// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MetaResponse } from '@ai-personal/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Footer } from './Footer.js';

const meta: MetaResponse = {
    name: 'AI-Personal',
    serverVersion: '0.0.0',
    protocolVersion: 1,
    license: 'AGPL-3.0-only',
    sourceUrl: 'https://example.com/src',
    capabilities: [],
};

describe('Footer', () => {
    it('配置了 sourceUrl 时显示源代码链接', () => {
        const html = renderToStaticMarkup(<Footer meta={meta} />);
        expect(html).toContain('href="https://example.com/src"');
        expect(html).toContain('AGPL-3.0-only');
    });

    it('无 meta 时仍显示许可证', () => {
        const html = renderToStaticMarkup(<Footer meta={null} />);
        expect(html).toContain('AGPL-3.0-only');
        expect(html).not.toContain('href=');
    });
});

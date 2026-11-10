// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AutoExtractNotice } from './AutoExtractNotice.js';

const noop = () => undefined;

describe('AutoExtractNotice', () => {
    it('自动抽取开启时显示一键关闭按钮', () => {
        const html = renderToStaticMarkup(
            <AutoExtractNotice autoExtract stopped={false} error={null} onTurnOff={noop} />,
        );
        expect(html).toContain('一键关闭自动抽取');
        expect(html).toContain('role="status"');
    });

    it('关闭后只显示已关闭的说明', () => {
        const html = renderToStaticMarkup(
            <AutoExtractNotice autoExtract={false} stopped error={null} onTurnOff={noop} />,
        );
        expect(html).toContain('自动抽取已关闭');
        expect(html).not.toContain('<button');
    });

    it('默认关闭且没操作过时不显示', () => {
        const html = renderToStaticMarkup(
            <AutoExtractNotice autoExtract={false} stopped={false} error={null} onTurnOff={noop} />,
        );
        expect(html).toBe('');
    });
});

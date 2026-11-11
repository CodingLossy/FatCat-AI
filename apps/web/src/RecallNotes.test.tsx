// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nContext, translator } from './i18n.js';
import { RecallNotes, recallNotes } from './RecallNotes.js';

const render = (node: React.ReactNode, locale: 'zh-CN' | 'en' = 'zh-CN') =>
    renderToStaticMarkup(<I18nContext.Provider value={{ locale, t: translator(locale) }}>{node}</I18nContext.Provider>);

describe('召回不完整的说明(ADR 0017 第 5 节)', () => {
    it('按原因显示;auth / rejected 链接到设置页;不认识的值按原因未知', () => {
        expect(render(<RecallNotes degraded={[{ path: 'vector', reason: 'timeout' }]} omitted={0} />)).toContain(
            '向量检索超时,本轮只用了全文与关联检索',
        );
        expect(render(<RecallNotes degraded={[{ path: 'vector', reason: 'error' }]} omitted={0} />)).toContain(
            '向量检索出错',
        );
        const auth = render(<RecallNotes degraded={[{ path: 'vector', reason: 'auth' }]} omitted={0} />);
        expect(auth).toContain('嵌入密钥可能失效');
        expect(auth).toContain('href="/settings"');
        expect(render(<RecallNotes degraded={[{ path: 'vector', reason: 'rejected' }]} omitted={0} />)).toContain(
            '嵌入接口拒绝了请求',
        );
        // 以后新增的路径或原因(旧客户端不认识)
        const future = [{ path: 'vector', reason: 'skipped' }] as unknown as Parameters<typeof recallNotes>[0];
        expect(recallNotes(future)).toEqual([{ key: 'unknown', settings: false }]);
        expect(recallNotes([{ path: 'fts', reason: 'error' }])).toEqual([{ key: 'unknown', settings: false }]);
        expect(
            recallNotes([
                { path: 'vector', reason: 'timeout' },
                { path: 'vector', reason: 'timeout' },
            ]),
        ).toHaveLength(1);
    });

    it('omitted > 0 时显示未展示条数;都没有时不显示;英文也有', () => {
        expect(render(<RecallNotes degraded={[]} omitted={2} />)).toContain('另有 2 条相关记忆未展示');
        expect(render(<RecallNotes degraded={[]} omitted={0} />)).toBe('');
        expect(render(<RecallNotes degraded={[{ path: 'vector', reason: 'timeout' }]} omitted={3} />, 'en')).toMatch(
            /Vector search timed out.*3 more relevant memories were not shown/,
        );
    });
});

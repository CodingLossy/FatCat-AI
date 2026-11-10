// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MemorySource } from '@fatcat-ai/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemorySources } from './MemorySources.js';

const base = {
    sessionId: null,
    userMessageId: null,
    answerMessageId: null,
    itemId: null,
    excerpt: null,
    createdAt: '2026-11-10T08:00:00.000Z',
};
const run = {
    id: 'run_1',
    job: 'memory.extract' as const,
    profileId: 'p1',
    model: 'deepseek-chat',
    promptVersion: 'abcdef123456',
    status: 'succeeded' as const,
    errorCode: null,
    createdAt: '2026-11-10T08:00:00.000Z',
};

describe('MemorySources', () => {
    it('模型抽取的出处显示模型、状态与提示词版本', () => {
        const html = renderToStaticMarkup(<MemorySources sources={[{ ...base, id: 's1', extractRun: run }]} />);
        expect(html).toContain('由 deepseek-chat 自动抽取于');
        expect(html).toContain('成功');
        expect(html).toContain('abcdef123456');
    });

    it('失败的运行显示错误码', () => {
        const failed = { ...run, status: 'failed' as const, errorCode: 'invalid_output' };
        const html = renderToStaticMarkup(<MemorySources sources={[{ ...base, id: 's1', extractRun: failed }]} />);
        expect(html).toContain('失败(invalid_output)');
    });

    it('手动写入或迁移前的出处(null 或缺省)显示没有生成记录,摘录按纯文本显示', () => {
        const sources: MemorySource[] = [
            { ...base, id: 's1', extractRun: null },
            { ...base, id: 's2', excerpt: '<b>我对花生过敏</b>' },
        ];
        const html = renderToStaticMarkup(<MemorySources sources={sources} />);
        expect(html.match(/没有生成记录/g)).toHaveLength(2);
        expect(html).toContain('&lt;b&gt;');
    });

    it('没有出处时说明', () => {
        expect(renderToStaticMarkup(<MemorySources sources={[]} />)).toContain('没有记录出处');
    });
});

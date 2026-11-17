// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ToolInfo } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { buildAllowedTools, preauthCandidates } from './preauth.js';

const tool = (over: Partial<ToolInfo>): ToolInfo => ({
    name: 'x',
    description: '',
    risk: 'read',
    approval: 'required',
    source: 'builtin',
    server: null,
    preauthorizable: true,
    constraints: [],
    ...over,
});

describe('预授权选择器', () => {
    const fetchTool = tool({ name: 'web.fetch', constraints: ['domain'], requiredConstraint: 'domain' });
    const kb = tool({ name: 'kb.search' });
    const list = [
        fetchTool,
        kb,
        tool({ name: 'calc', approval: 'auto' }),
        tool({ name: 'mail.send', risk: 'external', preauthorizable: false }),
        tool({ name: 'fs.write', risk: 'write' }),
    ];

    it('只列出默认要审批的只读且可预授权的工具;mail.send 一类不会出现', () => {
        expect(preauthCandidates(list).map((t) => t.name)).toEqual(['web.fetch', 'kb.search']);
    });

    it('web.fetch 必须带域名,没填就报缺范围', () => {
        const picked = { 'web.fetch': { on: true, scope: ' ' }, 'kb.search': { on: true, scope: '' } };
        expect(buildAllowedTools([fetchTool, kb], picked)).toEqual({
            allowed: [],
            problem: { tool: 'web.fetch', kind: 'missing' },
        });
        const filled = { ...picked, 'web.fetch': { on: true, scope: ' News.Example.com ' } };
        expect(buildAllowedTools([fetchTool, kb], filled)).toEqual({
            allowed: [{ tool: 'web.fetch', constraint: { domain: 'news.example.com' } }, { tool: 'kb.search' }],
            problem: null,
        });
    });

    it('域名可以填多个;带协议 / 路径 / 端口时报具体原因', () => {
        const pick = (scope: string) => ({ 'web.fetch': { on: true, scope } });
        expect(buildAllowedTools([fetchTool], pick('bbc.com, www.bbc.com')).allowed).toEqual([
            { tool: 'web.fetch', constraint: { domain: 'bbc.com' } },
            { tool: 'web.fetch', constraint: { domain: 'www.bbc.com' } },
        ]);
        for (const [value, kind] of [
            ['https://bbc.com', 'protocol'],
            ['bbc.com/news', 'path'],
            ['bbc.com:443', 'port'],
        ] as const) {
            expect(buildAllowedTools([fetchTool], pick(value)).problem).toEqual({ tool: 'web.fetch', kind, value });
        }
    });
});

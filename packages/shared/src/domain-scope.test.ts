// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { bareDomainSuggestion, matchesDomain, parseDomainScope, splitDomainScopes } from './domain-scope.js';

describe('预授权域名范围', () => {
    it('匹配规则固定(ADR 0039):裸域名只匹配本身;*.example.com 匹配子域,不匹配 example.com 本身', () => {
        expect(matchesDomain('bbc.com', 'bbc.com')).toBe(true);
        expect(matchesDomain('www.bbc.com', 'bbc.com')).toBe(false);
        expect(matchesDomain('www.bbc.com', '*.bbc.com')).toBe(true);
        expect(matchesDomain('a.b.bbc.com', '*.bbc.com')).toBe(true);
        expect(matchesDomain('bbc.com', '*.bbc.com')).toBe(false);
        // 后缀必须在点边界上
        expect(matchesDomain('evilbbc.com', '*.bbc.com')).toBe(false);
        expect(matchesDomain('WWW.BBC.COM.', '*.bbc.com')).toBe(true);
    });

    it('规范化合法写法,并对带协议 / 路径 / 端口 / 过宽的通配给出原因', () => {
        expect(parseDomainScope(' News.Example.com. ')).toEqual({ ok: 'news.example.com' });
        expect(parseDomainScope('*.example.com')).toEqual({ ok: '*.example.com' });
        expect(parseDomainScope('https://example.com')).toEqual({ problem: 'protocol' });
        expect(parseDomainScope('example.com/news')).toEqual({ problem: 'path' });
        expect(parseDomainScope('example.com?x=1')).toEqual({ problem: 'path' });
        expect(parseDomainScope('example.com:8080')).toEqual({ problem: 'port' });
        expect(parseDomainScope('*.com')).toEqual({ problem: 'broad' });
        expect(parseDomainScope('user@example.com')).toEqual({ problem: 'invalid' });
        expect(parseDomainScope('exa mple.com')).toEqual({ problem: 'invalid' });
        expect(parseDomainScope('  ')).toEqual({ problem: 'empty' });
    });

    it('拆分输入与裸域名建议', () => {
        expect(splitDomainScopes('a.com, b.com;a.com  c.com')).toEqual(['a.com', 'b.com', 'c.com']);
        expect(bareDomainSuggestion('bbc.com')).toEqual({ www: 'www.bbc.com', wildcard: '*.bbc.com' });
        expect(bareDomainSuggestion('www.bbc.com')).toBeNull();
        expect(bareDomainSuggestion('*.bbc.com')).toBeNull();
    });
});

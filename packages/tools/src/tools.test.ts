// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Preauthorization } from '@ai-personal/shared';
import { describe, expect, it } from 'vitest';
import {
    checkRemember,
    decide,
    inputDigest,
    redactedInput,
    ToolRegistry,
    type ToolContext,
    type ToolDefinition,
} from './index.js';

const SESSION = '01JC0000000000000000000000';
const OTHER_SESSION = '01JC0000000000000000000001';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    ownerId: 'owner',
    sessionId: SESSION,
    runId: 'run',
    userMessageId: 'u',
    assistantMessageId: 'a',
    untrustedContentSeen: false,
    ...over,
});

const tool = (over: Partial<ToolDefinition>): ToolDefinition => ({
    name: 'test.tool',
    description: '',
    parameters: { type: 'object' },
    risk: 'read',
    summarize: () => 'summary',
    execute: () => Promise.resolve(null),
    ...over,
});

const pathOf = (input: unknown) => (input as { path?: string }).path ?? null;
const hostOf = (input: unknown) => {
    try {
        return new URL((input as { url: string }).url).hostname;
    } catch {
        return null;
    }
};

const preauth = (over: Partial<Preauthorization>): Preauthorization => ({
    id: 'p1',
    toolName: 'test.tool',
    scope: 'always',
    sessionId: null,
    constraint: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    lastUsedAt: null,
    ...over,
});

describe('decide:默认策略(ADR 0010 第 2 节)', () => {
    it('read 直接执行;write / external 需审批;dangerous 默认禁用,启用后每次都要审批', () => {
        expect(decide(tool({ risk: 'read' }), {}, ctx(), [])).toEqual({ action: 'run', decision: 'auto' });
        expect(decide(tool({ risk: 'write' }), {}, ctx(), [])).toEqual({ action: 'ask' });
        expect(decide(tool({ risk: 'external' }), {}, ctx(), [])).toEqual({ action: 'ask' });
        expect(decide(tool({ risk: 'dangerous' }), {}, ctx(), [])).toMatchObject({ action: 'deny' });
        expect(decide(tool({ risk: 'dangerous' }), {}, ctx(), [], { enableDangerous: true })).toEqual({
            action: 'ask',
        });
    });

    it('工具只能比级别更严:read + approval required 需审批', () => {
        expect(decide(tool({ risk: 'read', approval: 'required' }), {}, ctx(), [])).toEqual({ action: 'ask' });
    });
});

describe('decide:预授权与条件预授权', () => {
    const write = tool({ risk: 'write', constraints: { pathPrefix: pathOf } });

    it('永久预授权对所有会话生效;本会话预授权只对该会话生效', () => {
        expect(decide(write, {}, ctx(), [preauth({})])).toEqual({
            action: 'run',
            decision: 'preauthorized',
            preauthId: 'p1',
        });
        const sessionOnly = preauth({ scope: 'session', sessionId: SESSION });
        expect(decide(write, {}, ctx(), [sessionOnly])).toMatchObject({ action: 'run' });
        expect(decide(write, {}, ctx({ sessionId: OTHER_SESSION }), [sessionOnly])).toEqual({ action: 'ask' });
    });

    it('越权:其他工具的预授权、路径前缀边界外、取不出参数时都不生效', () => {
        expect(decide(write, {}, ctx(), [preauth({ toolName: 'other.tool' })])).toEqual({ action: 'ask' });
        const docs = [preauth({ constraint: { pathPrefix: '/home/u/docs' } })];
        expect(decide(write, { path: '/home/u/docs/a.md' }, ctx(), docs)).toMatchObject({ action: 'run' });
        expect(decide(write, { path: '/home/u/docs' }, ctx(), docs)).toMatchObject({ action: 'run' });
        expect(decide(write, { path: '/home/u/docs-private/a.md' }, ctx(), docs)).toEqual({ action: 'ask' });
        expect(decide(write, {}, ctx(), docs)).toEqual({ action: 'ask' });
        // 工具不支持的约束:取不出值,视为不匹配
        expect(decide(write, {}, ctx(), [preauth({ constraint: { domain: 'example.com' } })])).toEqual({
            action: 'ask',
        });
    });

    it('域名约束:精确域名不含子域,*.域名只含子域', () => {
        const fetch = tool({ risk: 'read', approval: 'required', constraints: { domain: hostOf } });
        const exact = [preauth({ constraint: { domain: 'example.com' } })];
        const wildcard = [preauth({ constraint: { domain: '*.example.com' } })];
        expect(decide(fetch, { url: 'https://example.com/a' }, ctx(), exact)).toMatchObject({ action: 'run' });
        expect(decide(fetch, { url: 'https://api.example.com/a' }, ctx(), exact)).toEqual({ action: 'ask' });
        expect(decide(fetch, { url: 'https://api.example.com/a' }, ctx(), wildcard)).toMatchObject({ action: 'run' });
        expect(decide(fetch, { url: 'https://example.com/a' }, ctx(), wildcard)).toEqual({ action: 'ask' });
        expect(decide(fetch, { url: 'https://evilexample.com/a' }, ctx(), wildcard)).toEqual({ action: 'ask' });
    });

    it('越权:external / dangerous 即使存在预授权记录也照样审批', () => {
        expect(decide(tool({ risk: 'external' }), {}, ctx(), [preauth({})])).toEqual({ action: 'ask' });
        expect(decide(tool({ risk: 'dangerous' }), {}, ctx(), [preauth({})], { enableDangerous: true })).toEqual({
            action: 'ask',
        });
    });

    it('条件预授权:条件成立才直接执行;本次运行见过不可信内容或设置关闭时失效', () => {
        const conditional = tool({ risk: 'write', autoApproveWhen: (input) => (input as { ok: boolean }).ok });
        expect(decide(conditional, { ok: true }, ctx(), [])).toEqual({ action: 'run', decision: 'conditional' });
        expect(decide(conditional, { ok: false }, ctx(), [])).toEqual({ action: 'ask' });
        expect(decide(conditional, { ok: true }, ctx({ untrustedContentSeen: true }), [])).toEqual({
            action: 'ask',
        });
        expect(decide(conditional, { ok: true }, ctx(), [], { disableConditional: true })).toEqual({
            action: 'ask',
        });
        const external = tool({ risk: 'external', autoApproveWhen: () => true });
        expect(decide(external, {}, ctx(), [])).toEqual({ action: 'ask' });
    });
});

describe('checkRemember', () => {
    it('external / dangerous 不能预授权;只能用工具支持的约束', () => {
        expect(checkRemember(tool({ risk: 'external' }), { scope: 'always' })).toMatch(/cannot be pre-authorized/);
        expect(checkRemember(tool({ risk: 'dangerous' }), { scope: 'session' })).toMatch(/cannot/);
        const write = tool({ risk: 'write', constraints: { pathPrefix: pathOf } });
        expect(checkRemember(write, { scope: 'always', constraint: { pathPrefix: '/docs' } })).toBeNull();
        expect(checkRemember(write, { scope: 'always', constraint: { domain: 'example.com' } })).toMatch(/domain/);
        expect(checkRemember(write, { scope: 'session' })).toBeNull();
    });
});

describe('ToolRegistry', () => {
    it('拒绝重复或非法的名称;禁用的工具不交给模型;info 按名称排序', () => {
        const registry = new ToolRegistry();
        registry.register(tool({ name: 'b.write', risk: 'write', constraints: { pathPrefix: pathOf } }));
        registry.register(tool({ name: 'a.shell', risk: 'dangerous' }));
        expect(() => registry.register(tool({ name: 'b.write' }))).toThrow(/duplicate/);
        expect(() => registry.register(tool({ name: 'Bad Name' }))).toThrow(/invalid/);
        expect(registry.size).toBe(2);
        expect(registry.get('b.write')?.risk).toBe('write');
        expect(registry.specs().map((s) => s.name)).toEqual(['b.write']);
        expect(registry.info()).toEqual([
            expect.objectContaining({ name: 'a.shell', approval: 'disabled', preauthorizable: false }),
            expect.objectContaining({
                name: 'b.write',
                approval: 'required',
                preauthorizable: true,
                source: 'builtin',
                server: null,
                constraints: ['pathPrefix'],
            }),
        ]);
        const enabled = new ToolRegistry({ enableDangerous: true }).register(
            tool({ name: 'a.shell', risk: 'dangerous' }),
        );
        expect(enabled.info()[0]).toMatchObject({ approval: 'required', preauthorizable: false });
        expect(enabled.specs()).toHaveLength(1);
    });
});

describe('审计摘要', () => {
    const redact = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]');

    it('脱敏并截断到 500 字符', () => {
        expect(inputDigest({ key: 'sk-abcdef' }, redact)).toBe('{"key":"[REDACTED]"}');
        const long = inputDigest({ text: 'x'.repeat(1000) }, redact);
        expect(long).toHaveLength(500);
        expect(long.endsWith('…')).toBe(true);
        expect(inputDigest(undefined, redact)).toBe('null');
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(inputDigest(cyclic, redact)).toBe('[unserializable input]');
    });

    it('审批请求中的入参脱敏后仍保持结构', () => {
        expect(redactedInput({ path: 'a.md' }, redact)).toEqual({ path: 'a.md' });
        expect(redactedInput({ key: 'sk-abcdef' }, redact)).toEqual({ key: '[REDACTED]' });
        expect(redactedInput(undefined, redact)).toBeNull();
        // 脱敏破坏了 JSON 时退回为字符串
        expect(typeof redactedInput({ a: 'sk-1"' }, (t) => t.replace('sk-1', '"'))).toBe('string');
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(redactedInput(cyclic, redact)).toBe('[unserializable input]');
    });
});

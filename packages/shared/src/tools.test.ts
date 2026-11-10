// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    AgentEvent,
    ApprovalDecision,
    ApprovalQuery,
    ApprovalRequest,
    AuditEntry,
    AuditQuery,
    PreauthRemember,
    ToolInfo,
    UntrustedContent,
} from './index.js';

const ID = '01JC0000000000000000000000';
const NOW = '2026-11-04T12:00:00.000Z';

describe('ApprovalDecision(ADR 0010 第 3 节)', () => {
    it('M1 的请求体仍然有效;remember 可选,支持本会话 / 永久与参数约束', () => {
        expect(ApprovalDecision.parse({ decision: 'reject' })).toEqual({ decision: 'reject' });
        expect(
            ApprovalDecision.parse({
                decision: 'approve',
                remember: { scope: 'always', constraint: { pathPrefix: 'D:\\Docs' } },
            }).remember,
        ).toEqual({ scope: 'always', constraint: { pathPrefix: 'D:\\Docs' } });
    });

    it('拒绝未知的范围、未知的约束键和非法域名', () => {
        expect(PreauthRemember.safeParse({ scope: 'forever' }).success).toBe(false);
        expect(PreauthRemember.safeParse({ scope: 'session', constraint: { anything: 'x' } }).success).toBe(false);
        expect(PreauthRemember.safeParse({ scope: 'session', extra: true }).success).toBe(false);
        for (const domain of ['Example.com', 'http://example.com', 'example.com/path', '-bad.com']) {
            expect(PreauthRemember.safeParse({ scope: 'session', constraint: { domain } }).success, domain).toBe(false);
        }
        expect(PreauthRemember.safeParse({ scope: 'session', constraint: { domain: '*.example.com' } }).success).toBe(
            true,
        );
    });
});

describe('审批与审计类型', () => {
    it('ApprovalRequest / ToolInfo / AuditEntry 解析服务器返回的结构', () => {
        expect(
            ApprovalRequest.parse({
                callId: ID,
                runId: ID,
                sessionId: ID,
                toolName: 'fs.write',
                risk: 'write',
                summary: 'Write notes.md',
                input: { path: 'notes.md' },
                status: 'pending',
                preauthorizable: true,
                createdAt: NOW,
                expiresAt: NOW,
                decidedAt: null,
            }).status,
        ).toBe('pending');
        expect(
            ToolInfo.parse({
                name: 'mcp.files.read_file',
                description: '',
                risk: 'write',
                approval: 'required',
                source: 'mcp',
                server: 'files',
                preauthorizable: true,
                constraints: [],
            }).source,
        ).toBe('mcp');
        const entry = {
            id: ID,
            at: NOW,
            action: 'tool-call',
            toolName: 'fs.write',
            risk: 'write',
            callId: ID,
            runId: ID,
            sessionId: ID,
            decision: 'denied',
            outcome: 'not_run',
            summary: 'Path outside authorized folders',
            inputDigest: '{"path":"C:\\\\Windows\\\\x"}',
            error: null,
        };
        expect(AuditEntry.parse(entry).decision).toBe('denied');
        expect(AuditEntry.safeParse({ ...entry, inputDigest: 'x'.repeat(501) }).success).toBe(false);
    });

    it('查询参数沿用游标分页,并校验过滤条件', () => {
        expect(ApprovalQuery.parse({ status: 'pending' })).toMatchObject({ status: 'pending', limit: 50 });
        expect(AuditQuery.parse({ limit: '10', risk: 'external' })).toMatchObject({ limit: 10, risk: 'external' });
        expect(AuditQuery.safeParse({ risk: 'unknown' }).success).toBe(false);
    });

    it('UntrustedContent 的 untrusted 恒为 true', () => {
        const content = { source: { kind: 'web', ref: 'https://example.com' }, content: 'x', truncated: false };
        expect(UntrustedContent.safeParse({ untrusted: true, ...content }).success).toBe(true);
        expect(UntrustedContent.safeParse({ untrusted: false, ...content }).success).toBe(false);
    });
});

describe('审批事件的增量字段(ADR 0010 第 9 节)', () => {
    it('M1 形态的事件仍然有效,新增字段可选', () => {
        const base = { type: 'approval-required', runId: ID, callId: 'c1', summary: 's' } as const;
        expect(AgentEvent.parse(base)).toEqual(base);
        expect(AgentEvent.parse({ ...base, toolName: 'fs.write', risk: 'write', expiresAt: NOW })).toMatchObject({
            risk: 'write',
        });
        const resolved = { type: 'approval-resolved', runId: ID, callId: 'c1', decision: 'reject' } as const;
        expect(AgentEvent.parse(resolved)).toEqual(resolved);
        expect(AgentEvent.parse({ ...resolved, reason: 'expired' })).toMatchObject({ reason: 'expired' });
        expect(AgentEvent.safeParse({ ...resolved, reason: 'timeout' }).success).toBe(false);
    });
});

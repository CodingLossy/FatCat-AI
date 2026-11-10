// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AgentEvent, EventEnvelope, ToolInfo } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { parentFolder, rememberConstraint } from './remember.js';
import { applyEvent, isValidKeyRef, newTurn, pendingApprovals } from './live-turn.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
let seq = 0;
const env = (event: AgentEvent): EventEnvelope => ({
    seq: ++seq,
    at: new Date(0).toISOString(),
    sessionId: null,
    event,
});

describe('applyEvent', () => {
    it('归并正文、工具调用、审批与结果,未知事件不改变状态', () => {
        const events: AgentEvent[] = [
            { type: 'run-started', runId: RUN, sessionId: RUN, userMessageId: RUN, assistantMessageId: RUN },
            { type: 'tool-call', runId: RUN, callId: 'c1', name: 'memory.save', input: { text: '住杭州' } },
            { type: 'approval-required', runId: RUN, callId: 'c1', summary: '保存记忆:住杭州' },
        ];
        let turn = events.reduce((t, e) => applyEvent(t, env(e)), newTurn('记住我住杭州'));
        expect(turn.runId).toBe(RUN);
        expect(pendingApprovals(turn).map((t) => t.callId)).toEqual(['c1']);

        turn = applyEvent(turn, env({ type: 'assistant-state', state: 'thinking' }));
        turn = applyEvent(turn, env({ type: 'future-event', runId: RUN } as unknown as AgentEvent));
        turn = applyEvent(turn, env({ type: 'approval-resolved', runId: RUN, callId: 'c1', decision: 'reject' }));
        turn = applyEvent(
            turn,
            env({ type: 'tool-result', runId: RUN, callId: 'c1', output: null, error: 'rejected' }),
        );
        turn = applyEvent(turn, env({ type: 'text-delta', runId: RUN, delta: '好的,' }));
        turn = applyEvent(turn, env({ type: 'text-delta', runId: RUN, delta: '不记了。' }));
        turn = applyEvent(turn, env({ type: 'run-finished', runId: RUN, reason: 'stop' }));

        expect(pendingApprovals(turn)).toEqual([]);
        expect(turn).toMatchObject({
            text: '好的,不记了。',
            done: true,
            finishReason: 'stop',
            tools: [
                {
                    callId: 'c1',
                    approval: { summary: '保存记忆:住杭州', decision: 'reject' },
                    result: { error: 'rejected' },
                },
            ],
        });
    });

    it('重复的 tool-call(续看补发)不会产生两张卡片;run-failed 记录错误', () => {
        const call: AgentEvent = { type: 'tool-call', runId: RUN, callId: 'c1', name: 'x', input: {} };
        let turn = applyEvent(applyEvent(newTurn(null, RUN), env(call)), env(call));
        expect(turn.tools).toHaveLength(1);
        turn = applyEvent(
            turn,
            env({
                type: 'run-failed',
                runId: RUN,
                error: {
                    type: 'about:blank',
                    title: 'Bad Gateway',
                    status: 502,
                    code: 'internal',
                    requestId: 'r1',
                },
            }),
        );
        expect(turn).toMatchObject({ done: true, error: { status: 502 } });
    });
});

describe('isValidKeyRef', () => {
    it('只接受 env: / file: 引用或留空,拒绝明文密钥', () => {
        expect(isValidKeyRef('env:DEEPSEEK_API_KEY')).toBe(true);
        expect(isValidKeyRef('file:deepseek')).toBe(true);
        expect(isValidKeyRef('')).toBe(true);
        expect(isValidKeyRef('sk-THISISNOTAREALKEY0123456789abcdef')).toBe(false);
        expect(isValidKeyRef('env:')).toBe(false);
        expect(isValidKeyRef('env:A B')).toBe(false);
    });
});

describe('rememberConstraint', () => {
    const info = (over: Partial<ToolInfo>): ToolInfo => ({
        name: 'web.fetch',
        description: '',
        risk: 'read',
        approval: 'required',
        source: 'builtin',
        server: null,
        preauthorizable: true,
        constraints: ['domain'],
        requiredConstraint: 'domain',
        ...over,
    });

    it('按域名预授权:取本次网址的主机名;取不出时不能记住;工具不支持约束时整体预授权', () => {
        expect(rememberConstraint(info({}), { url: 'https://Docs.Example.com/a?b' })).toEqual({
            domain: 'docs.example.com',
        });
        expect(rememberConstraint(info({}), { url: 'not a url' })).toBeNull();
        expect(rememberConstraint(info({}), {})).toBeNull();
        expect(rememberConstraint(info({ constraints: [], requiredConstraint: null }), {})).toBeUndefined();
        expect(rememberConstraint(undefined, {})).toBeUndefined();
    });
});

describe('按目录预授权(文件工具)', () => {
    const fsInfo: ToolInfo = {
        name: 'fs.write',
        description: '',
        risk: 'write',
        approval: 'required',
        source: 'builtin',
        server: null,
        preauthorizable: true,
        constraints: ['pathPrefix'],
        requiredConstraint: 'pathPrefix',
    };

    it('取目标所在的文件夹;移动时取目标的文件夹;取不出时不能记住', () => {
        expect(rememberConstraint(fsInfo, { path: 'D:\\Docs\\notes\\a.md' })).toEqual({
            pathPrefix: 'D:\\Docs\\notes',
        });
        expect(rememberConstraint(fsInfo, { from: '/a/x', to: '/home/u/docs/y.md' })).toEqual({
            pathPrefix: '/home/u/docs',
        });
        expect(rememberConstraint(fsInfo, { path: 'a.md' })).toBeNull();
        expect(parentFolder('C:\\file.txt')).toBe('C:\\');
        expect(parentFolder('/file')).toBe('/');
        expect(parentFolder('notes/a.md')).toBe('notes');
        expect(parentFolder('D:\\Docs\\')).toBe('D:\\');
    });
});

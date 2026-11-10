// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    AgentEvent,
    ClientFrame,
    CreatedAccessToken,
    EventEnvelope,
    Id,
    isTerminalEvent,
    MemorySaveInput,
    MemorySearchInput,
    ModelProfileInput,
    ModelProfilePatch,
    PageQuery,
    pageOf,
    ProblemDetails,
    SendMessageRequest,
    ServerFrame,
    SettingsPatch,
} from './index.js';

const ID = '01JC0000000000000000000000';
const ID2 = '01JC0000000000000000000001';
const NOW = '2026-11-03T12:00:00.000Z';

describe('Id', () => {
    it('接受 ULID,拒绝其他格式', () => {
        expect(Id.safeParse(ID).success).toBe(true);
        expect(Id.safeParse('01jc0000000000000000000000').success).toBe(false);
        expect(Id.safeParse('01JC000000000000000000000I').success).toBe(false);
        expect(Id.safeParse('123').success).toBe(false);
    });
});

describe('ProblemDetails', () => {
    it('填充默认 type,并拒绝未知错误码', () => {
        const p = ProblemDetails.parse({ title: 'Unauthorized', status: 401, code: 'unauthorized', requestId: 'r1' });
        expect(p.type).toBe('about:blank');
        expect(ProblemDetails.safeParse({ title: 'x', status: 401, code: 'nope', requestId: 'r1' }).success).toBe(
            false,
        );
    });

    it('status 只能是 4xx / 5xx', () => {
        expect(ProblemDetails.safeParse({ title: 'x', status: 200, code: 'internal', requestId: 'r' }).success).toBe(
            false,
        );
    });
});

describe('分页', () => {
    it('limit 从查询字符串转换,并有默认值与上限', () => {
        expect(PageQuery.parse({}).limit).toBe(50);
        expect(PageQuery.parse({ limit: '20' }).limit).toBe(20);
        expect(PageQuery.safeParse({ limit: '201' }).success).toBe(false);
    });

    it('pageOf 生成 { items, nextCursor }', () => {
        const page = pageOf(Id).parse({ items: [ID], nextCursor: null });
        expect(page.items).toEqual([ID]);
    });
});

describe('ModelProfileInput', () => {
    const base = { label: 'Local', kind: 'openai-compatible', model: 'qwen3:8b', purpose: ['chat'] } as const;

    it('openai-compatible 必须有 baseURL', () => {
        expect(ModelProfileInput.safeParse({ ...base, apiKeyRef: null }).success).toBe(false);
        expect(
            ModelProfileInput.safeParse({ ...base, apiKeyRef: null, baseURL: 'http://127.0.0.1:11434/v1' }).success,
        ).toBe(true);
    });

    it('只接受 env: / file: 密钥引用,拒绝明文 key', () => {
        const withUrl = { ...base, baseURL: 'https://api.example.com/v1' };
        expect(ModelProfileInput.safeParse({ ...withUrl, apiKeyRef: 'env:DEEPSEEK_API_KEY' }).success).toBe(true);
        expect(ModelProfileInput.safeParse({ ...withUrl, apiKeyRef: 'file:deepseek' }).success).toBe(true);
        expect(ModelProfileInput.safeParse({ ...withUrl, apiKeyRef: 'sk-abcdef1234567890' }).success).toBe(false);
        expect(ModelProfileInput.safeParse({ ...withUrl, apiKeyRef: 'env:' }).success).toBe(false);
    });

    it('拒绝未知字段(例如明文 apiKey)', () => {
        const withUrl = { ...base, baseURL: 'https://api.example.com/v1', apiKeyRef: null };
        expect(ModelProfileInput.safeParse({ ...withUrl, apiKey: 'sk-abcdef1234567890' }).success).toBe(false);
        expect(ModelProfilePatch.safeParse({ apiKey: 'sk-abcdef1234567890' }).success).toBe(false);
    });

    it('baseURL 只允许 http / https', () => {
        expect(ModelProfileInput.safeParse({ ...base, apiKeyRef: null, baseURL: 'file:///etc/passwd' }).success).toBe(
            false,
        );
    });
});

describe('SendMessageRequest', () => {
    it('拒绝空文本与非法幂等键', () => {
        expect(SendMessageRequest.safeParse({ text: '' }).success).toBe(false);
        expect(SendMessageRequest.safeParse({ text: 'hi', clientMessageId: 'a b' }).success).toBe(false);
        expect(SendMessageRequest.safeParse({ text: 'hi', clientMessageId: 'abc-123' }).success).toBe(true);
    });
});

describe('AgentEvent', () => {
    it('解析各类事件并识别终止事件', () => {
        const delta = AgentEvent.parse({ type: 'text-delta', runId: ID, delta: '你好' });
        const done = AgentEvent.parse({ type: 'run-finished', runId: ID, reason: 'stop' });
        const failed = AgentEvent.parse({
            type: 'run-failed',
            runId: ID,
            error: {
                title: 'Upstream',
                status: 502,
                code: 'provider_error',
                requestId: 'r',
                providerCode: 'auth_failed',
            },
        });
        expect(isTerminalEvent(delta)).toBe(false);
        expect(isTerminalEvent(done)).toBe(true);
        expect(isTerminalEvent(failed)).toBe(true);
    });

    it('拒绝未知事件类型', () => {
        expect(AgentEvent.safeParse({ type: 'mystery', runId: ID }).success).toBe(false);
    });

    it('事件信封要求正的 seq', () => {
        const event = { type: 'text-delta', runId: ID, delta: 'x' };
        expect(EventEnvelope.safeParse({ seq: 1, at: NOW, sessionId: ID2, event }).success).toBe(true);
        expect(EventEnvelope.safeParse({ seq: 0, at: NOW, sessionId: ID2, event }).success).toBe(false);
    });
});

describe('记忆 v1', () => {
    it('默认 memType 为 semantic,并限制文本长度', () => {
        expect(MemorySaveInput.parse({ text: '用户常住杭州' }).memType).toBe('semantic');
        expect(MemorySaveInput.safeParse({ text: 'x'.repeat(201) }).success).toBe(false);
        expect(MemorySaveInput.safeParse({ text: ' ' }).success).toBe(false);
    });

    it('entityKey 必须是规范化键', () => {
        expect(MemorySaveInput.safeParse({ text: '杭州', entityKey: 'user.location.city' }).success).toBe(true);
        expect(MemorySaveInput.safeParse({ text: '杭州', entityKey: 'User City' }).success).toBe(false);
    });

    it('检索 limit 默认 12,上限 30', () => {
        expect(MemorySearchInput.parse({ query: '住哪' }).limit).toBe(12);
        expect(MemorySearchInput.safeParse({ query: '住哪', limit: 31 }).success).toBe(false);
    });
});

describe('WebSocket 帧', () => {
    it('解析 hello 与 event 帧', () => {
        expect(
            ClientFrame.parse({ v: 1, type: 'hello', id: 'c1', payload: { protocolVersion: 1, lastSeq: 42 } }).type,
        ).toBe('hello');
        const frame = ServerFrame.parse({
            v: 1,
            type: 'event',
            id: 's1',
            seq: 43,
            payload: { seq: 43, at: NOW, sessionId: ID2, event: { type: 'text-delta', runId: ID, delta: 'x' } },
        });
        expect(frame.type).toBe('event');
    });

    it('拒绝其他协议版本', () => {
        expect(ClientFrame.safeParse({ v: 2, type: 'ping', id: 'c1', payload: {} }).success).toBe(false);
    });
});

describe('其他', () => {
    it('设置可以只更新记忆子字段', () => {
        expect(SettingsPatch.parse({ memory: {} })).toEqual({ memory: {} });
        expect(SettingsPatch.safeParse({ locale: 'fr' }).success).toBe(false);
    });

    it('访问令牌格式为 aip_pat_ 前缀', () => {
        const token = {
            id: ID,
            name: 'cli',
            createdAt: NOW,
            lastUsedAt: null,
            expiresAt: null,
            token: 'aip_pat_' + 'a'.repeat(43),
        };
        expect(CreatedAccessToken.safeParse(token).success).toBe(true);
        expect(CreatedAccessToken.safeParse({ ...token, token: 'ghp_xxx' }).success).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { ILINK_DEFAULT_BASE_URL, QQ_API_BASE_URL } from '@fatcat-ai/channels';
import { ANTHROPIC_BASE_URL } from '@fatcat-ai/providers';
import { EgressTarget, type McpServer } from '@fatcat-ai/shared';
import type { ChannelRecord, MailAccountRecord, ModelProfileRecord } from '@fatcat-ai/storage';
import { describe, expect, it, vi } from 'vitest';
import {
    channelTargets,
    embeddingTargets,
    listEgressTargets,
    mailTargets,
    mcpTargets,
    modelTargets,
    normalizeOrigin,
    voiceTargets,
} from './egress.js';

const profile = (over: Partial<ModelProfileRecord>): ModelProfileRecord => ({
    id: 'p1',
    label: 'Chat',
    kind: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    apiKeyRef: 'env:SECRET_KEY',
    model: 'm',
    purpose: ['chat'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
});

const channel = (over: Partial<ChannelRecord>): ChannelRecord => ({
    id: 'c1',
    ownerId: 'o',
    kind: 'wechat',
    label: 'WeChat',
    enabled: true,
    sessionId: null,
    notifyDegraded: false,
    config: { token: 'file:wechat_token' },
    createdAt: '',
    updatedAt: '',
    binding: null,
    ...over,
});

describe('normalizeOrigin', () => {
    it('lowercases, drops default ports, paths, queries, fragments and user info', () => {
        expect(normalizeOrigin('HTTPS://API.Example.COM:443/v1/chat?key=abc#frag')).toBe('https://api.example.com');
        expect(normalizeOrigin('http://user:pw@Host.example:8080/a/b?x=1')).toBe('http://host.example:8080');
        expect(normalizeOrigin('imaps://Mail.Example.com:993')).toBe('imaps://mail.example.com');
        expect(normalizeOrigin('smtp://mail.example.com:587')).toBe('smtp://mail.example.com:587');
    });

    it('returns null for an address that cannot be parsed', () => {
        expect(normalizeOrigin('not a url')).toBeNull();
        expect(normalizeOrigin('')).toBeNull();
    });
});

describe('targets per category', () => {
    it('model: chat profiles, with provider defaults when no baseURL is set', () => {
        const targets = modelTargets([
            profile({ id: 'a', baseURL: 'https://API.example.com/v1?token=x' }),
            profile({ id: 'b', kind: 'anthropic', purpose: ['cheap'] }),
            profile({ id: 'c', purpose: ['embed'] }),
        ]);
        expect(targets.map((t) => [t.id, t.origin])).toEqual([
            ['model:a', 'https://api.example.com'],
            ['model:b', 'https://api.example.com'],
        ]);
        const noBase = modelTargets([
            { ...profile({ id: 'b', kind: 'anthropic', purpose: ['chat'] }), baseURL: undefined as never },
        ]);
        expect(noBase[0]?.origin).toBe(normalizeOrigin(ANTHROPIC_BASE_URL));
    });

    it('embedding: only the profile that is actually used is enabled', () => {
        const targets = embeddingTargets([
            profile({ id: 'e1', purpose: ['embed'] }),
            profile({ id: 'e2', purpose: ['embed'], baseURL: 'https://other.example.com' }),
        ]);
        expect(targets.map((t) => [t.id, t.enabled])).toEqual([
            ['embedding:e1', true],
            ['embedding:e2', false],
        ]);
    });

    it('voice: stt and tts follow the default profile, else the first usable one', () => {
        const targets = voiceTargets(
            [
                profile({ id: 's1', purpose: ['stt'] }),
                profile({ id: 't1', purpose: ['tts'], baseURL: 'https://tts1.example.com' }),
                profile({ id: 't2', purpose: ['tts'], baseURL: 'https://tts2.example.com' }),
            ],
            { defaultSttProfileId: null, defaultTtsProfileId: 't2' },
        );
        expect(targets.map((t) => [t.id, t.source.id, t.origin])).toEqual([
            ['voice:stt', 's1', 'https://api.example.com'],
            ['voice:tts', 't2', 'https://tts2.example.com'],
        ]);
    });

    it('mail: one IMAP and one SMTP target per account', () => {
        const account = {
            id: 'm1',
            label: 'Work',
            enabled: false,
            imap: { host: 'IMAP.Example.com', port: 993, security: 'tls' },
            smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' },
        } as unknown as MailAccountRecord;
        const targets = mailTargets([account]);
        expect(targets.map((t) => [t.id, t.origin, t.enabled])).toEqual([
            ['mail:m1:imap', 'imaps://imap.example.com', false],
            ['mail:m1:smtp', 'smtp://smtp.example.com:587', false],
        ]);
    });

    it('channel: a disabled WeChat channel is listed with enabled false; baseUrl overrides the default', () => {
        const targets = channelTargets([
            channel({ id: 'c1', enabled: false }),
            channel({ id: 'c2', config: { baseUrl: 'https://ilink2.example.com' } }),
        ]);
        expect(targets.map((t) => [t.id, t.origin, t.enabled])).toEqual([
            ['channel:c1', normalizeOrigin(ILINK_DEFAULT_BASE_URL), false],
            ['channel:c2', 'https://ilink2.example.com', true],
        ]);
    });

    it('channel: a QQ channel lists the REST host and the wss:// gateway on api.bot.qq.com', () => {
        const targets = channelTargets([channel({ id: 'q1', kind: 'qq', config: { appId: '1' } })]);
        expect(targets.map((t) => [t.id, t.origin, t.enabled])).toEqual([
            ['channel:q1', 'https://api.bot.qq.com', true],
            ['channel:q1:gateway', 'wss://api.bot.qq.com', true],
        ]);
        expect(QQ_API_BASE_URL).toBe('https://api.bot.qq.com');
    });

    it('mcp: a stdio server is a local process without an origin', () => {
        const server = { id: 's1', name: 'files', enabled: true } as unknown as McpServer;
        expect(mcpTargets([server])).toEqual([
            {
                id: 'mcp:s1',
                category: 'mcp',
                label: 'files',
                origin: null,
                local: true,
                source: { kind: 'mcp-server', id: 's1' },
                enabled: true,
            },
        ]);
    });
});

describe('listEgressTargets', () => {
    it('skips an unparsable address with a log line that does not contain it, and leaks no secrets', () => {
        const log = vi.fn();
        const list = listEgressTargets(
            {
                profiles: [
                    profile({ id: 'bad', baseURL: 'http//secret-host.invalid/path' }),
                    profile({ id: 'ok', baseURL: 'https://user:pw@api.example.com/v1' }),
                ],
                voice: { defaultSttProfileId: null, defaultTtsProfileId: null },
                mailAccounts: [],
                channels: [channel({})],
                mcpServers: [],
            },
            log,
        );
        expect(list.targets.map((t) => t.id)).toEqual(['model:ok', 'channel:c1']);
        expect(JSON.stringify(log.mock.calls)).not.toContain('secret-host');
        const json = JSON.stringify(list);
        for (const leaked of ['SECRET_KEY', 'wechat_token', 'pw@', '/v1']) expect(json).not.toContain(leaked);
        for (const t of list.targets) expect(EgressTarget.safeParse(t).success).toBe(true);
    });
});

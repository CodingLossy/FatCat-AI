// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { createRecordingFetch, createReplayFetch, type Fixture } from './replay.js';

const KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';
const redact = (t: string) => t.split(KEY).join('[REDACTED]');

describe('录制', () => {
    it('不保存请求头,按 SSE 事件分块,落盘前脱敏', async () => {
        const real: typeof fetch = () =>
            Promise.resolve(
                new Response(`data: {"echo":"${KEY}"}\n\ndata: [DONE]\n\n`, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream', 'set-cookie': 'a=b', 'x-request-id': 'r1' },
                }),
            );
        const rec = createRecordingFetch({ name: 'x', redact, realFetch: real });
        const res = await rec.fetch('https://api.example.com/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}` },
            body: JSON.stringify({ model: 'm', note: KEY }),
        });
        expect(await res.text()).toContain(KEY); // 调用方拿到的是原始响应

        const fixture = rec.fixture();
        const json = JSON.stringify(fixture);
        expect(json).not.toContain(KEY);
        expect(json).not.toContain('set-cookie');
        expect(json).not.toContain('authorization');
        expect(fixture.interactions[0]!.request.path).toBe('/v1/chat/completions');
        expect(fixture.interactions[0]!.response.chunks).toHaveLength(2);
    });
});

describe('回放', () => {
    const fixture: Fixture = {
        name: 'f',
        synthetic: true,
        interactions: [
            { request: { method: 'GET', path: '/v1/models' }, response: { status: 200, headers: {}, chunks: ['ok'] } },
        ],
    };

    it('按顺序返回交互,方法或路径不符时报错', async () => {
        const r = createReplayFetch(fixture);
        expect(await (await r.fetch('http://h/v1/models')).text()).toBe('ok');
        expect(r.remaining()).toBe(0);
        await expect(r.fetch('http://h/v1/models')).rejects.toThrow(/no more interactions/);
        await expect(createReplayFetch(fixture).fetch('http://h/v1/other')).rejects.toThrow(
            /expected GET \/v1\/models/,
        );
    });
});

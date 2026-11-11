// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EventEnvelope } from '@fatcat-ai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createDebouncer, IDLE, reduceAssistantState, type ShownState } from './voice-state.js';

const NOW = Date.parse('2026-11-11T03:00:00.000Z');
const env = (event: EventEnvelope['event'], agoMs = 0, sessionId: string | null = 's1'): EventEnvelope => ({
    seq: 1,
    at: new Date(NOW - agoMs).toISOString(),
    sessionId,
    event,
});

describe('reduceAssistantState', () => {
    it('事件序列 → 显示状态:以最后一个为准', () => {
        let s: ShownState = IDLE;
        const events = [
            env({ type: 'assistant-state', state: 'listening', label: '正在听…' }),
            env({ type: 'assistant-state', state: 'thinking', label: '正在思考…' }),
            env({ type: 'text-delta', runId: 'r', delta: 'x' }),
            env({ type: 'assistant-state', state: 'executing', label: '正在读取网页…', toolName: 'web.fetch' }),
            env({ type: 'assistant-state', state: 'speaking' }),
        ];
        const seen = events.map((e) => (s = reduceAssistantState(s, e, NOW)).state);
        expect(seen).toEqual(['listening', 'thinking', 'thinking', 'executing', 'speaking']);
        expect(s).toEqual({ state: 'speaking', label: null, sessionId: 's1' });
    });

    it('30 秒前的状态按 idle', () => {
        const old = env({ type: 'assistant-state', state: 'listening' }, 31_000);
        expect(reduceAssistantState(IDLE, old, NOW)).toEqual(IDLE);
    });
});

describe('createDebouncer', () => {
    it('稳定 150 ms 后才显示,快速交替只显示最后一个', () => {
        vi.useFakeTimers();
        const shown: string[] = [];
        const d = createDebouncer((s) => shown.push(s.state));
        d.push({ state: 'thinking', label: null, sessionId: null });
        vi.advanceTimersByTime(100);
        d.push({ state: 'executing', label: null, sessionId: null });
        vi.advanceTimersByTime(100);
        d.push({ state: 'thinking', label: null, sessionId: null });
        vi.advanceTimersByTime(149);
        expect(shown).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(shown).toEqual(['thinking']);
        d.push({ state: 'thinking', label: null, sessionId: null });
        vi.advanceTimersByTime(500);
        expect(shown).toEqual(['thinking']);
        d.dispose();
        vi.useRealTimers();
    });
});

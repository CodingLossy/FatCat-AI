// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { createVad, silenceExpired, type VadEvent } from './vad.js';

/** 每 30 ms 喂一帧,返回产生的事件与对应时间。 */
function feed(levels: readonly [level: number, ms: number][], vad = createVad()) {
    const events: [VadEvent, number][] = [];
    let now = 0;
    for (const [level, ms] of levels) {
        for (const end = now + ms; now < end; now += 30) {
            const e = vad.push(level, now);
            if (e) events.push([e, now]);
        }
    }
    return { vad, events };
}

describe('本地能量 VAD(ADR 0049 第 2.2 节)', () => {
    it('用前 300 ms 估计底噪,阈值是底噪的 3 倍,并有上下限', () => {
        expect(feed([[0.05, 330]]).vad.threshold()).toBeCloseTo(0.15);
        // 完全静音(假麦克风)时用下限
        expect(feed([[0, 330]]).vad.threshold()).toBe(0.06);
        // 校准时就在说话:阈值不会高到再也听不到
        expect(feed([[0.9, 330]]).vad.threshold()).toBe(0.5);
        expect(feed([[0.05, 200]]).vad.threshold()).toBeNull();
    });

    it('校准期间的说话不触发事件', () => {
        expect(feed([[0.9, 300]]).events).toEqual([]);
    });

    it('连续超过阈值约 200 ms 才算开始说话;说完停顿约 800 ms 结束这一段', () => {
        const { events } = feed([
            [0.02, 330],
            [0.5, 600],
            [0.02, 1200],
        ]);
        expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end']);
        const [onset, start, end] = events.map(([, t]) => t);
        expect(start! - onset!).toBeGreaterThanOrEqual(200);
        expect(start! - onset!).toBeLessThan(260);
        // 最后一帧响声在 900 ms 左右,结束在它之后约 800 ms
        expect(end! - 930).toBeGreaterThanOrEqual(800);
        expect(end! - 930).toBeLessThan(860);
    });

    it('咳嗽、敲键盘这类短促的声音只有 onset / cancel,不算说话', () => {
        const { events, vad } = feed([
            [0.02, 330],
            [0.8, 90],
            [0.02, 300],
            [0.8, 120],
            [0.02, 300],
        ]);
        expect(events.map(([e]) => e)).toEqual(['onset', 'cancel', 'onset', 'cancel']);
        expect(vad.phase()).toBe('quiet');
    });

    it('句中短暂停顿(短于 800 ms)不会把一段话切成两段', () => {
        const { events } = feed([
            [0.02, 330],
            [0.5, 600],
            [0.02, 500],
            [0.5, 600],
            [0.02, 1000],
        ]);
        expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end']);
    });

    it('两段话之间停顿够长时切成两段', () => {
        const { events } = feed([
            [0.02, 330],
            [0.5, 600],
            [0.02, 1200],
            [0.5, 600],
            [0.02, 1200],
        ]);
        expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end', 'onset', 'start', 'end']);
    });

    it('静音自动结束只在没说话时判断', () => {
        expect(silenceExpired(0, 8000, 8000, 'quiet')).toBe(true);
        expect(silenceExpired(0, 7999, 8000, 'quiet')).toBe(false);
        expect(silenceExpired(0, 9000, 8000, 'speech')).toBe(false);
        expect(silenceExpired(0, 9000, 8000, 'trailing')).toBe(false);
        expect(silenceExpired(0, 9000, 8000, 'onset')).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { isUsableRecording, MIN_LEVEL_SAMPLES, MIN_RECORDING_MS, playSegments, SILENCE_LEVEL } from './audio.js';

describe('playSegments', () => {
    it('停止后被中止的预取段不会留下未处理的 rejection', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const errors: unknown[] = [];
            const fetchAudio = (text: string, signal: AbortSignal) =>
                text === 'a'
                    ? new Promise<Blob>((resolve) => setTimeout(() => resolve(new Blob(['x'])), 10))
                    : Promise.reject(signal.aborted ? new Error('aborted') : new Error('unexpected'));
            const playback = playSegments(['a', 'b'], fetchAudio, {
                onLevel: () => undefined,
                onStart: () => undefined,
                onError: (e) => errors.push(e),
            });
            playback.stop();
            await playback.done;
            await new Promise((r) => setTimeout(r, 20));
            expect(unhandled).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe('isUsableRecording', () => {
    it('太短或几乎无声的录音不发去转写;不能测电平时只看时长', () => {
        expect(isUsableRecording(MIN_RECORDING_MS - 1, 0.5)).toBe(false);
        expect(isUsableRecording(2000, SILENCE_LEVEL / 2)).toBe(false);
        expect(isUsableRecording(2000, SILENCE_LEVEL)).toBe(true);
        expect(isUsableRecording(2000, null)).toBe(true);
        expect(isUsableRecording(100, null)).toBe(false);
        // 标签页在后台时几乎没有电平采样,不按静音丢掉
        expect(isUsableRecording(2000, 0, 0)).toBe(true);
        expect(isUsableRecording(2000, 0, MIN_LEVEL_SAMPLES)).toBe(false);
    });
});

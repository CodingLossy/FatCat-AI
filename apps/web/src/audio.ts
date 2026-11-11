// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 浏览器里的录音与播放(ADR 0021):录音用 MediaRecorder,时长到 120 秒自动结束;电平用 AnalyserNode 计算,
// 只在本地驱动指示器,不上报服务器。
import { MAX_RECORDING_SECONDS } from '@fatcat-ai/shared';

export type LevelListener = (level: number) => void;

let sharedContext: AudioContext | null = null;
function audioContext(): AudioContext | null {
    try {
        sharedContext ??= new AudioContext();
        if (sharedContext.state === 'suspended') void sharedContext.resume();
        return sharedContext;
    } catch {
        return null;
    }
}

/** 按 RMS 估算电平(0–1),每帧回调一次;返回停止函数。 */
function meter(source: AudioNode, ctx: AudioContext, onLevel: LevelListener): () => void {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let frame: number | null = null;
    const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
        if (frame !== null) cancelAnimationFrame(frame);
        analyser.disconnect();
    };
}

export function canRecord(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** 短于这个时长的录音不发去转写(多半是误触)。 */
export const MIN_RECORDING_MS = 500;
/**
 * 整段录音的最大电平(与 meter 相同的 0–1 刻度,约为 RMS 0.01)低于这个值时视为静音。
 * 几乎无声的录音交给转写模型时,常被「转写」成别的语言的胡乱文字(M4 真机测试)。
 */
export const SILENCE_LEVEL = 0.04;

/** 录音是否值得发去转写;peakLevel 为 null 表示浏览器不能测电平,此时只看时长。 */
export function isUsableRecording(durationMs: number, peakLevel: number | null): boolean {
    if (durationMs < MIN_RECORDING_MS) return false;
    return peakLevel === null || peakLevel >= SILENCE_LEVEL;
}

export interface Recording {
    /** 结束录音并返回音频;没有数据、太短(< 0.5 秒)或几乎无声时返回 null,不发去转写。 */
    stop(): Promise<Blob | null>;
    /** 放弃这次录音。 */
    cancel(): void;
}

/** 开始录音;onLimit 在达到 120 秒时调用(调用方随后应 stop)。 */
export async function startRecording(onLevel: LevelListener, onLimit: () => void): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };
    const ctx = audioContext();
    let peak: number | null = ctx ? 0 : null;
    const stopMeter = ctx
        ? meter(ctx.createMediaStreamSource(stream), ctx, (level) => {
              peak = Math.max(peak ?? 0, level);
              onLevel(level);
          })
        : () => undefined;
    const startedAt = performance.now();
    const limit = setTimeout(onLimit, MAX_RECORDING_SECONDS * 1000);
    const release = () => {
        clearTimeout(limit);
        stopMeter();
        for (const track of stream.getTracks()) track.stop();
    };
    recorder.start();
    return {
        stop: () =>
            new Promise((resolve) => {
                recorder.onstop = () => {
                    release();
                    const usable = chunks.length > 0 && isUsableRecording(performance.now() - startedAt, peak);
                    resolve(usable ? new Blob(chunks, { type: recorder.mimeType }) : null);
                };
                if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
                else recorder.stop();
            }),
        cancel: () => {
            recorder.onstop = null;
            if (recorder.state !== 'inactive') recorder.stop();
            release();
        },
    };
}

export interface Playback {
    /** 全部播完或被停止后 resolve。 */
    done: Promise<void>;
    stop(): void;
}

/** 依次请求并播放每一段;onStart 在第一段开始播放时调用。 */
export function playSegments(
    segments: readonly string[],
    fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob>,
    handlers: { onLevel: LevelListener; onStart: () => void; onError: (error: unknown) => void },
): Playback {
    const controller = new AbortController();
    let audio: HTMLAudioElement | null = null;
    let stopMeter: () => void = () => undefined;
    const done = (async () => {
        let started = false;
        // 下一段在当前段播放时就开始请求,减少段间停顿。预取的 Promise 先挂一个空的 catch:
        // 停止或出错后循环不再 await 它,它被中止时的 rejection 不能变成未处理的错误。
        const prefetch = (text: string | undefined) => {
            if (!text) return null;
            const promise = fetchAudio(text, controller.signal);
            promise.catch(() => undefined);
            return promise;
        };
        let next = prefetch(segments[0]);
        for (let i = 0; i < segments.length && next; i++) {
            const blob = await next;
            next = prefetch(segments[i + 1]);
            if (controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            try {
                audio = new Audio(url);
                const ctx = audioContext();
                if (ctx) {
                    const source = ctx.createMediaElementSource(audio);
                    source.connect(ctx.destination);
                    stopMeter = meter(source, ctx, handlers.onLevel);
                }
                const ended = new Promise<void>((resolve, reject) => {
                    audio!.onended = () => resolve();
                    audio!.onerror = () => reject(new Error('audio playback failed'));
                    controller.signal.addEventListener('abort', () => resolve(), { once: true });
                });
                await audio.play();
                if (!started) {
                    started = true;
                    handlers.onStart();
                }
                await ended;
            } finally {
                stopMeter();
                audio?.pause();
                audio = null;
                URL.revokeObjectURL(url);
            }
        }
    })().catch((error: unknown) => {
        if (!controller.signal.aborted) handlers.onError(error);
    });
    return {
        done,
        stop: () => {
            controller.abort();
            audio?.pause();
        },
    };
}

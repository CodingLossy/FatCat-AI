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

export interface Recording {
    /** 结束录音并返回音频;太短(没有数据)时返回 null。 */
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
    const stopMeter = ctx ? meter(ctx.createMediaStreamSource(stream), ctx, onLevel) : () => undefined;
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
                    resolve(chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType }) : null);
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
        // 下一段在当前段播放时就开始请求,减少段间停顿
        let next: Promise<Blob> | null = segments[0] ? fetchAudio(segments[0], controller.signal) : null;
        for (let i = 0; i < segments.length && next; i++) {
            const blob = await next;
            const following = segments[i + 1];
            next = following ? fetchAudio(following, controller.signal) : null;
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

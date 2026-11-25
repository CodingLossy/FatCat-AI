// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 连续对话(ADR 0049 第 2、10 节):麦克风一直开着,本地 VAD 断句,每段录完交给聊天页转写并发送。
// 对话放在模块里而不是组件里:空白页发出第一句后会新建会话、换一个聊天页组件,对话要接着进行。
// 离开聊天页(组件卸载后一秒内没有新的聊天页接上)就结束对话、关闭麦克风。
import { MAX_RECORDING_SECONDS } from '@fatcat-ai/shared';
import { useSyncExternalStore } from 'react';
import { audioContext, isUsableRecording, levelOf, pickRecorderMimeType } from './audio.js';
import { createVad, silenceExpired, type VadOptions } from './vad.js';

export type ConversationEnd = 'user' | 'silence' | 'hidden' | 'offline' | 'mic-lost' | 'left' | 'error';

export interface ConversationState {
    active: boolean;
    /** 正在录这一段(VAD 确认开始说话之后)。 */
    speech: boolean;
}

export interface ConversationHandlers {
    onLevel(level: number): void;
    /** 确认开始说话:朗读中就停下(打断只停朗读,不取消运行)。 */
    onSpeechStart(): void;
    /** 一段话录完;太短或几乎无声的已经丢掉。 */
    onSegment(blob: Blob): void;
    /** 朗读、转写、等回复时不计入静音时长。 */
    isPaused(): boolean;
    onEnded(reason: ConversationEnd): void;
}

/** 每隔这么久读一次电平。 */
const TICK_MS = 30;
/** 聊天页卸载后等这么久;没有新的聊天页接上就结束对话。 */
const DETACH_GRACE_MS = 1000;

interface Active {
    stop(reason: ConversationEnd): void;
}

let current: Active | null = null;
let starting = false;
let handlers: ConversationHandlers | null = null;
let detachTimer: ReturnType<typeof setTimeout> | null = null;
/** 没有聊天页接着时录完的段落,接上后补交。 */
let pendingSegments: Blob[] = [];
let state: ConversationState = { active: false, speech: false };
/**
 * 主界面打开时自动开始聆听(ADR 0049 第 10.3 节)。用户暂停、静音超时、断网等结束之后不再自动打开,
 * 直到刷新页面;切到后台或离开聊天页造成的结束,回来时自动恢复。
 */
let autoListen = true;
const listeners = new Set<() => void>();

function setState(next: ConversationState) {
    if (next.active === state.active && next.speech === state.speech) return;
    state = next;
    for (const l of listeners) l();
}

export function conversationState(): ConversationState {
    return state;
}

export function useConversation(): ConversationState {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => state,
    );
}

/** 聊天页挂上自己的处理函数;返回的函数在卸载时调用。 */
export function attachConversation(next: ConversationHandlers): () => void {
    handlers = next;
    if (detachTimer) {
        clearTimeout(detachTimer);
        detachTimer = null;
    }
    const queued = pendingSegments;
    pendingSegments = [];
    for (const blob of queued) next.onSegment(blob);
    return () => {
        if (handlers !== next) return;
        handlers = null;
        if (!current) return;
        detachTimer = setTimeout(() => {
            detachTimer = null;
            if (!handlers) endConversation('left');
        }, DETACH_GRACE_MS);
    };
}

/** 现在是否应该自动开始聆听:没被用户暂停过、页面在前台、麦克风已经授权、音频能直接运行。 */
export async function canAutoListen(): Promise<boolean> {
    if (!autoListen || current || starting || document.visibilityState !== 'visible') return false;
    try {
        // 没授权过就不自动打开:第一次要由用户点球,浏览器才弹出授权
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (permission.state !== 'granted') return false;
    } catch {
        return false;
    }
    const ctx = audioContext();
    if (!ctx) return false;
    // 浏览器的自动播放策略可能让没有用户操作的音频上下文停着,那样听不到声音,不如等用户点球
    if (ctx.state !== 'running') {
        await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
    }
    return ctx.state === 'running' && autoListen && !current;
}

export function endConversation(reason: ConversationEnd = 'user') {
    current?.stop(reason);
}

/** 打开麦克风开始连续对话;已经开着时什么也不做。麦克风打不开时抛出错误。 */
export async function startConversation(silenceEndMs: number, vadOptions: Partial<VadOptions> = {}): Promise<void> {
    if (current || starting) return;
    starting = true;
    let stream: MediaStream;
    try {
        // 朗读时麦克风也开着:打开回声消除与降噪,免得把自己的朗读当成用户在说话
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
    } finally {
        starting = false;
    }
    const ctx = audioContext();
    if (!ctx) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error('Web Audio is not available');
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const vad = createVad(vadOptions);
    const mimeType = pickRecorderMimeType((m) => MediaRecorder.isTypeSupported(m));

    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let segmentStart = 0;
    let segmentPeak = 0;
    let lastHeardAt = performance.now();

    const beginSegment = () => {
        const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunks = [];
        segmentPeak = 0;
        segmentStart = performance.now();
        r.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };
        r.start();
        recorder = r;
    };
    const dropSegment = () => {
        if (!recorder) return;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
        recorder = null;
    };
    const finishSegment = () => {
        const r = recorder;
        if (!r) return;
        recorder = null;
        const got = chunks;
        const duration = performance.now() - segmentStart;
        const peak = segmentPeak;
        r.onstop = () => {
            if (got.length === 0 || !isUsableRecording(duration, peak)) return;
            const blob = new Blob(got, { type: r.mimeType });
            if (handlers) handlers.onSegment(blob);
            else pendingSegments.push(blob);
        };
        r.stop();
    };

    const tick = () => {
        analyser.getByteTimeDomainData(data);
        const level = levelOf(data);
        const now = performance.now();
        handlers?.onLevel(level);
        if (recorder) segmentPeak = Math.max(segmentPeak, level);
        const event = vad.push(level, now);
        if (event === 'onset') beginSegment();
        else if (event === 'cancel') dropSegment();
        else if (event === 'start') {
            setState({ active: true, speech: true });
            handlers?.onSpeechStart();
        } else if (event === 'end') {
            finishSegment();
            setState({ active: true, speech: false });
        }
        // 一段话最长 120 秒,和按住说话相同
        if (recorder && vad.phase() !== 'onset' && now - segmentStart >= MAX_RECORDING_SECONDS * 1000) {
            finishSegment();
            beginSegment();
        }
        if (vad.phase() !== 'quiet' && vad.phase() !== 'calibrating') lastHeardAt = now;
        if (!handlers || handlers.isPaused()) lastHeardAt = now;
        if (silenceExpired(lastHeardAt, now, silenceEndMs, vad.phase())) stop('silence');
    };
    const timer = setInterval(tick, TICK_MS);

    const onVisibility = () => {
        if (document.visibilityState === 'hidden') stop('hidden');
    };
    const onOffline = () => stop('offline');
    const onTrackEnded = () => stop('mic-lost');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('offline', onOffline);
    for (const track of stream.getTracks()) track.addEventListener('ended', onTrackEnded);

    let stopped = false;
    function stop(reason: ConversationEnd) {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('offline', onOffline);
        // 用户点了结束:正在说的那一段丢掉;其他原因结束时也不再发送半句话
        dropSegment();
        source.disconnect();
        analyser.disconnect();
        for (const track of stream.getTracks()) {
            track.removeEventListener('ended', onTrackEnded);
            track.stop();
        }
        if (detachTimer) {
            clearTimeout(detachTimer);
            detachTimer = null;
        }
        current = null;
        pendingSegments = [];
        autoListen = reason === 'hidden' || reason === 'left';
        setState({ active: false, speech: false });
        handlers?.onEnded(reason);
    }

    current = { stop };
    setState({ active: true, speech: false });
    // 打开麦克风的这段时间里页面可能已经进了后台
    onVisibility();
}

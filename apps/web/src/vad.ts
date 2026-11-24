// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 连续对话的本地语音活动检测(ADR 0049 第 2.2 节):只看短时能量,不引入依赖、不下载模型。
// 电平只在浏览器里用,永不上报服务器(ADR 0021 第 6 节)。

export interface VadOptions {
    /** 开始时用这么久的电平估计底噪。 */
    calibrateMs: number;
    /** 阈值 = 底噪 × 这个倍数。 */
    floorFactor: number;
    /** 阈值的下限与上限(与 audio.ts 的电平同一刻度,0–1)。 */
    minThreshold: number;
    maxThreshold: number;
    /** 连续高于阈值这么久才算开始说话(过滤咳嗽、敲键盘)。 */
    startMs: number;
    /** 说话后连续低于阈值这么久算这一段结束。 */
    endMs: number;
}

export const DEFAULT_VAD: VadOptions = {
    calibrateMs: 300,
    floorFactor: 3,
    minThreshold: 0.06,
    maxThreshold: 0.5,
    startMs: 200,
    endMs: 800,
};

/**
 * - `onset`:电平刚越过阈值,调用方开始录音(这样开头的字不会丢)。
 * - `cancel`:没坚持到 startMs 就回落,丢掉刚开始的录音。
 * - `start`:确认开始说话(朗读时据此打断)。
 * - `end`:说完了,结束这一段并发送。
 */
export type VadEvent = 'onset' | 'cancel' | 'start' | 'end';

export type VadPhase = 'calibrating' | 'quiet' | 'onset' | 'speech' | 'trailing';

export interface Vad {
    /** 喂一帧电平;now 为毫秒时间戳(单调递增)。 */
    push(level: number, now: number): VadEvent | null;
    phase(): VadPhase;
    /** 校准完成后的阈值;校准中为 null。 */
    threshold(): number | null;
}

export function createVad(options: Partial<VadOptions> = {}): Vad {
    const o = { ...DEFAULT_VAD, ...options };
    let phase: VadPhase = 'calibrating';
    let startedAt: number | null = null;
    let sum = 0;
    let count = 0;
    let threshold: number | null = null;
    let since = 0;
    return {
        phase: () => phase,
        threshold: () => threshold,
        push(level, now) {
            if (phase === 'calibrating') {
                startedAt ??= now;
                sum += level;
                count++;
                if (now - startedAt < o.calibrateMs) return null;
                const floor = sum / count;
                threshold = Math.min(o.maxThreshold, Math.max(o.minThreshold, floor * o.floorFactor));
                phase = 'quiet';
                return null;
            }
            const loud = level >= threshold!;
            switch (phase) {
                case 'quiet':
                    if (!loud) return null;
                    phase = 'onset';
                    since = now;
                    return 'onset';
                case 'onset':
                    if (!loud) {
                        phase = 'quiet';
                        return 'cancel';
                    }
                    if (now - since < o.startMs) return null;
                    phase = 'speech';
                    return 'start';
                case 'speech':
                    if (loud) return null;
                    phase = 'trailing';
                    since = now;
                    return null;
                case 'trailing':
                    if (loud) {
                        phase = 'speech';
                        return null;
                    }
                    if (now - since < o.endMs) return null;
                    phase = 'quiet';
                    return 'end';
            }
        },
    };
}

/**
 * 连续对话该不该因为没人说话而结束:没在说话、也没有暂停(朗读、转写、等回复的时间不算),
 * 并且距离上次听到说话或上次恢复已经满 silenceEndMs。
 */
export function silenceExpired(lastHeardAt: number, now: number, silenceEndMs: number, phase: VadPhase): boolean {
    if (phase !== 'quiet' && phase !== 'calibrating') return false;
    return now - lastHeardAt >= silenceEndMs;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 猫咪主题说话时可选的一声「喵」(ADR 0049 第 10.7 节)。
// 用很短、很低的合成音,不放录音文件;默认关闭,开了也不盖住朗读。

/** 两声之间至少隔这么久,避免连着叫。 */
export const MEOW_GAP_MS = 4200;
/** 音量低于这个值时不叫(安静的间隙不算)。 */
export const MEOW_MIN_LEVEL = 0.35;
/** 峰值增益。朗读本身响得多,这一声垫在下面。 */
export const MEOW_PEAK_GAIN = 0.04;

/**
 * 这一帧该不该叫一声。lastMs 是上一声的时间;还没叫过(<= 0)时不算到点,
 * 由调用方在开始朗读时记下当前时间,这样第一声也不会压在开头。
 */
export function meowDue(lastMs: number, nowMs: number, level: number, enabled: boolean, speaking: boolean): boolean {
    if (!enabled || !speaking) return false;
    if (!(level >= MEOW_MIN_LEVEL)) return false;
    if (!(lastMs > 0)) return false;
    return nowMs - lastMs >= MEOW_GAP_MS;
}

/** 一声很短的下滑音。峰值见 MEOW_PEAK_GAIN。 */
export function playMeow(ctx: AudioContext, now = ctx.currentTime): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.16);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.32);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(MEOW_PEAK_GAIN, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
}

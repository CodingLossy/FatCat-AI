// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音状态指示器:粒子球 + 一行状态文字(aria-live="polite")。粒子球的代码按需加载;
// Canvas 不可用时只显示文字(ADR 0021 第 7 节、M4 方案问题 3)。
import type { AssistantState } from '@fatcat-ai/shared';
import type { VoiceOrb } from '@fatcat-ai/ui';
import { useEffect, useRef, useState } from 'react';

export function VoiceIndicator({
    state,
    label,
    level,
}: {
    state: AssistantState;
    label: string;
    /** 本端录音 / 播放的电平(每帧更新的 ref,避免整页重渲染);其他端的状态没有电平。 */
    level: { readonly current: number | null };
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const orb = useRef<VoiceOrb | null>(null);
    const [noCanvas, setNoCanvas] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void import('@fatcat-ai/ui')
            .then(({ createVoiceOrb }) => {
                if (cancelled || !canvas.current) return;
                orb.current = createVoiceOrb(canvas.current);
                if (!orb.current) setNoCanvas(true);
            })
            .catch(() => setNoCanvas(true));
        return () => {
            cancelled = true;
            orb.current?.destroy();
            orb.current = null;
        };
    }, []);

    useEffect(() => {
        orb.current?.setState(state);
    }, [state, noCanvas]);

    useEffect(() => {
        const timer = setInterval(() => orb.current?.setLevel(level.current), 50);
        return () => clearInterval(timer);
    }, [level]);

    return (
        <div className="voice-indicator" data-testid="voice-indicator" data-state={state}>
            {noCanvas ? null : <canvas ref={canvas} className="voice-orb" width={40} height={40} aria-hidden="true" />}
            <span className="voice-label" aria-live="polite">
                {label}
            </span>
        </div>
    );
}

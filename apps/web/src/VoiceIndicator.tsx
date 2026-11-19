// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音状态指示器:核心球(粒子线框球 + 猫线稿叠层)+ 声波条 + 一行状态文字(aria-live="polite")。
// 球的代码按需加载;Canvas 不可用时只显示文字(ADR 0021 第 7 节、ui-redesign.md 第 4 节)。
// 猫是独立的 SVG 叠层(原创线稿,戴 VR 眼镜和耳机),以后可直接换成最终图稿而不动 canvas 代码。
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
    const wave = useRef<HTMLCanvasElement>(null);
    const orb = useRef<VoiceOrb | null>(null);
    const [noCanvas, setNoCanvas] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void import('@fatcat-ai/ui')
            .then(({ createVoiceOrb }) => {
                if (cancelled || !canvas.current) return;
                orb.current = createVoiceOrb(canvas.current, { waveCanvas: wave.current });
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
            {noCanvas ? null : (
                <div className="voice-orb-wrap" aria-hidden="true">
                    <canvas ref={canvas} className="voice-orb" width={168} height={168} />
                    <CatLineArt />
                </div>
            )}
            {noCanvas ? null : <canvas ref={wave} className="voice-wave" width={280} height={32} aria-hidden="true" />}
            <span className="voice-label" aria-live="polite">
                {label}
            </span>
        </div>
    );
}

/** 球里的猫线稿:约占球直径的一半,1.6px 线条,戴 VR 眼镜和耳机。颜色取 currentColor / 强调色。 */
function CatLineArt() {
    return (
        <svg className="voice-cat" viewBox="0 0 100 100" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <g className="cat-line">
                <path d="M26 44 L24 16 L44 30 M74 44 L76 16 L56 30" />
                <path d="M26 44 C26 26 74 26 74 44 L74 62 C74 80 26 80 26 62 Z" />
                <path d="M22 50 C20 50 18 54 18 60 L18 66 C18 70 22 70 24 68 M78 50 C80 50 82 54 82 60 L82 66 C82 70 78 70 76 68" />
                <path d="M22 50 C22 22 78 22 78 50" />
                <rect x="30" y="46" width="40" height="14" rx="6" />
                <path d="M50 66 L47 70 L53 70 Z M50 70 L50 74 M50 74 C47 77 44 76 43 74 M50 74 C53 77 56 76 57 74" />
                <path d="M36 68 L22 66 M36 72 L22 74 M64 68 L78 66 M64 72 L78 74" opacity="0.6" />
            </g>
        </svg>
    );
}

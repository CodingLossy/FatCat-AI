// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音状态指示器:当前主题的主视觉(packages/ui 的 Hero 接口)+ 一行状态文字(aria-live="polite")。
// 主视觉的代码按需加载;Canvas 不可用时只显示文字(ADR 0021 第 7 节、ADR 0046)。
import type { AssistantState } from '@fatcat-ai/shared';
import type { Hero } from '@fatcat-ai/ui';
import { resolveTheme } from '@fatcat-ai/ui/theme-ids';
import { useEffect, useRef, useState } from 'react';

/** 各状态下光晕的基础强度(0–1)。 */
const ENERGY: Record<AssistantState, number> = {
    idle: 0.3,
    listening: 0.5,
    thinking: 0.75,
    speaking: 0.65,
    executing: 0.75,
};

export function VoiceIndicator({
    state,
    label,
    level,
}: {
    state: AssistantState;
    /** 状态文字;不给时不显示(极简主界面在球下面自己写状态行)。 */
    label?: string;
    /** 本端录音 / 播放的电平(每帧更新的 ref,避免整页重渲染);其他端的状态没有电平。 */
    level: { readonly current: number | null };
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const orb = useRef<Hero | null>(null);
    const [theme, setTheme] = useState(() => resolveTheme(document.documentElement.dataset.theme));
    const [noCanvas, setNoCanvas] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void import('@fatcat-ai/ui')
            .then(({ createHero }) => {
                if (cancelled || !canvas.current) return;
                orb.current = createHero(theme, canvas.current);
                if (!orb.current) setNoCanvas(true);
            })
            .catch(() => setNoCanvas(true));
        return () => {
            cancelled = true;
            orb.current?.destroy();
            orb.current = null;
        };
    }, [theme]);

    // 应用内切换主题改的是 <html data-theme>:换成新主题的主视觉
    useEffect(() => {
        const root = document.documentElement;
        const observer = new MutationObserver(() => setTheme(resolveTheme(root.dataset.theme)));
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        orb.current?.setState(state);
    }, [state, noCanvas, theme]);

    // 全窗口光晕跟主视觉:能量按状态、亮度随说话音量;写在工作台外壳的 CSS 变量上,减少动态时保持静态
    const shell = useRef<HTMLElement | null>(null);
    useEffect(() => {
        shell.current = canvas.current?.closest<HTMLElement>('.wb-shell') ?? null;
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const base = ENERGY[state];
        shell.current?.style.setProperty('--hero-energy', String(base));
        const timer = setInterval(() => {
            const value = level.current;
            orb.current?.setLevel(value);
            if (!reduced) shell.current?.style.setProperty('--hero-level', (value ?? 0).toFixed(2));
        }, 50);
        return () => {
            clearInterval(timer);
            shell.current?.style.removeProperty('--hero-level');
        };
    }, [level, state]);

    return (
        <div className="voice-indicator" data-testid="voice-indicator" data-state={state}>
            {noCanvas ? null : (
                <div className="voice-orb-wrap" aria-hidden="true">
                    <canvas ref={canvas} className="voice-orb" width={168} height={168} />
                </div>
            )}
            {label === undefined ? null : (
                <span className="voice-label" aria-live="polite">
                    {label}
                </span>
            )}
        </div>
    );
}

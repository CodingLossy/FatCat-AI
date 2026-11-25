// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主界面状态行下面的小音量条(ADR 0049 第 10 节):读本端录音 / 朗读的电平 ref,直接改 CSS 变量,不触发重渲染。
import { useEffect, useRef } from 'react';

export function LevelBar({ level }: { level: { readonly current: number | null } }) {
    const bar = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const timer = window.setInterval(() => {
            bar.current?.style.setProperty('--level', String(Math.min(1, Math.max(0, level.current ?? 0))));
        }, 80);
        return () => window.clearInterval(timer);
    }, [level]);
    return (
        <span className="level-bar" ref={bar} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
        </span>
    );
}

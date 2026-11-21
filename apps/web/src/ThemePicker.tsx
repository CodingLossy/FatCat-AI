// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页的主题选择:三套主题各一张带主视觉小预览的卡片(单选组,方向键切换)。
// 预览画的是该主题主视觉的静态一帧;还没做好的主题显示「即将推出」且不能选。
import type { Settings } from '@fatcat-ai/shared';
import { resolveTheme, THEMES, type ThemeId } from '@fatcat-ai/ui/theme-ids';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { useI18n } from './i18n.js';

const NAME_KEY = {
    tech: 'settings.themeTech',
    nature: 'settings.themeNature',
    cat: 'settings.themeCat',
} as const satisfies Record<ThemeId, string>;

function Preview({ theme }: { theme: ThemeId }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let hero: { destroy(): void } | null = null;
        let cancelled = false;
        void import('@fatcat-ai/ui')
            .then(({ createHero }) => {
                if (cancelled || !canvas.current) return;
                hero = createHero(theme, canvas.current, { reducedMotion: true });
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            hero?.destroy();
        };
    }, [theme]);
    return <canvas ref={canvas} className="theme-preview" width={96} height={96} aria-hidden="true" />;
}

export function ThemePicker({ value, onChange }: { value: Settings['theme']; onChange: (theme: ThemeId) => void }) {
    const { t } = useI18n();
    const current = resolveTheme(value);
    const ready = THEMES.filter((x) => x.ready).map((x) => x.id);

    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const step =
            e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step || ready.length < 2) return;
        e.preventDefault();
        const next = ready[(ready.indexOf(current) + step + ready.length) % ready.length];
        if (next) onChange(next);
    };

    return (
        <div className="field">
            <span id="theme-label">{t('settings.theme')}</span>
            <div className="theme-picker" role="radiogroup" aria-labelledby="theme-label" onKeyDown={onKey}>
                {THEMES.map(({ id, ready: ok }) => (
                    <button
                        key={id}
                        type="button"
                        role="radio"
                        className="theme-option"
                        data-theme-id={id}
                        aria-checked={current === id}
                        tabIndex={current === id ? 0 : -1}
                        disabled={!ok}
                        onClick={() => onChange(id)}
                    >
                        {ok ? <Preview theme={id} /> : <span className="theme-preview theme-preview-empty" />}
                        <span className="theme-name">{t(NAME_KEY[id])}</span>
                        {ok ? null : <span className="small muted">{t('settings.themeSoon')}</span>}
                    </button>
                ))}
            </div>
        </div>
    );
}

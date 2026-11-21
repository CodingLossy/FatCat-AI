// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 所有页面共用的表单控件:开关、分段控件、设置分组。形状和颜色只来自主题 token(styles.css 的控件变体),
// 页面里不再各写一套。
import type { ReactNode } from 'react';

/** 开关:原生 checkbox(键盘、表单、读屏都照常),外观由主题的 --switch-* 决定;hint 是一句短提示。 */
export function Switch({
    label,
    checked,
    onChange,
    name,
    hint,
    disabled,
    risk,
}: {
    label: ReactNode;
    checked: boolean;
    onChange: (checked: boolean) => void;
    name?: string;
    hint?: ReactNode;
    disabled?: boolean;
    /** 有风险的选项:提示用警示色。 */
    risk?: boolean;
}) {
    return (
        <label className="switch-row">
            <span className="switch-text">
                <span>{label}</span>
                {hint ? <small className={risk ? 'warn' : 'muted'}>{hint}</small> : null}
            </span>
            <input
                type="checkbox"
                name={name}
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
            />
        </label>
    );
}

/** 分段控件:单选,方向键在选项间移动。 */
export function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: readonly { value: T; label: ReactNode }[];
    onChange: (value: T) => void;
}) {
    const index = options.findIndex((o) => o.value === value);
    return (
        <div
            className="segmented"
            role="radiogroup"
            aria-label={label}
            onKeyDown={(e) => {
                const step =
                    e.key === 'ArrowRight' || e.key === 'ArrowDown'
                        ? 1
                        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                          ? -1
                          : 0;
                if (!step) return;
                e.preventDefault();
                const next = options[(index + step + options.length) % options.length];
                if (next) onChange(next.value);
            }}
        >
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    aria-pressed={o.value === value}
                    tabIndex={o.value === value ? 0 : -1}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** 设置页的一组:标题 + 单列内容。 */
export function SettingsGroup({ id, title, children }: { id?: string; title: ReactNode; children: ReactNode }) {
    return (
        <section
            className="card form settings-group"
            id={id}
            aria-label={typeof title === 'string' ? title : undefined}
        >
            <h2>{title}</h2>
            {children}
        </section>
    );
}

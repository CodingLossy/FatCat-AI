// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「通用」里的时区选择(ADR 0023):可搜索的输入框 + 列表;为空表示跟随服务器。
// 老服务器(Settings 没有 timeZone 字段,或 /settings/time-zones 返回 404)时不显示。
import type { SettingsPatch, TimeZoneInfo } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';
import { matchTimeZone } from './time-zone.js';

export function TimeZoneSetting({
    value,
    onChange,
}: {
    /** 当前设置;null 为跟随服务器,undefined 为老服务器(不显示)。 */
    value: string | null | undefined;
    onChange: (patch: SettingsPatch) => Promise<void>;
}) {
    const { t } = useI18n();
    const [info, setInfo] = useState<TimeZoneInfo | null>(null);
    const [draft, setDraft] = useState(value ?? '');
    const [invalid, setInvalid] = useState(false);
    // 设置从外部变化(保存成功、点「跟随服务器」)时,输入框跟着变
    const [shown, setShown] = useState(value);
    if (shown !== value) {
        setShown(value);
        setDraft(value ?? '');
    }

    useEffect(() => {
        if (value === undefined) return;
        let alive = true;
        api.settings
            .timeZones()
            .then((i) => alive && setInfo(i))
            .catch(() => alive && setInfo(null)); // 老服务器或出错:不显示这个设置
        return () => {
            alive = false;
        };
    }, [value === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

    if (value === undefined || !info) return null;

    const commit = () => {
        if (draft.trim() === '') {
            setInvalid(false);
            if (value !== null) void onChange({ timeZone: null });
            return;
        }
        const tz = matchTimeZone(draft, info.supported);
        setInvalid(tz === null);
        if (tz && tz !== value) void onChange({ timeZone: tz });
        else if (tz) setDraft(tz);
    };

    return (
        <label>
            {t('settings.timeZone')}
            <span className="row">
                <input
                    name="timeZone"
                    list="time-zone-options"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('settings.timeZonePlaceholder')}
                    aria-invalid={invalid}
                    value={draft}
                    onChange={(e) => {
                        setDraft(e.target.value);
                        setInvalid(false);
                        // 从列表中选中时直接保存
                        const tz = matchTimeZone(e.target.value, info.supported);
                        if (tz && tz === e.target.value && tz !== value) void onChange({ timeZone: tz });
                    }}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commit();
                        }
                    }}
                />
                {value !== null ? (
                    <button type="button" onClick={() => void onChange({ timeZone: null })}>
                        {t('settings.timeZoneFollowServer')}
                    </button>
                ) : null}
            </span>
            <datalist id="time-zone-options">
                {info.supported.map((tz) => (
                    <option key={tz} value={tz} />
                ))}
            </datalist>
            <span className={`small ${invalid ? 'error' : 'muted'}`}>
                {invalid
                    ? t('settings.timeZoneInvalid')
                    : value === null
                      ? t('settings.timeZoneFollowing', { tz: info.serverTimeZone })
                      : t('settings.timeZoneSelected', { tz: value })}
            </span>
        </label>
    );
}

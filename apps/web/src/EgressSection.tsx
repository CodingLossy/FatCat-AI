// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「外连目标」一节(ADR 0028):只读,按类别分组。label 来自用户配置,一律按纯文本显示。
import type { EgressCategory, EgressTarget } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';

const ORDER: EgressCategory[] = ['model', 'embedding', 'voice', 'mail', 'channel', 'mcp', 'plugin', 'update-check'];

export function EgressSection() {
    const { t } = useI18n();
    const [targets, setTargets] = useState<EgressTarget[] | null>(null);
    const [available, setAvailable] = useState(true); // 老服务器没有这个接口(404):整节不显示

    useEffect(() => {
        let alive = true;
        api.settings
            .egressTargets()
            .then((r) => alive && setTargets(r.targets))
            .catch(() => alive && setAvailable(false));
        return () => {
            alive = false;
        };
    }, []);

    if (!available || !targets) return null;

    const groups = ORDER.map((category) => ({
        category,
        items: targets.filter((x) => x.category === category),
    })).filter((g) => g.items.length > 0);

    return (
        <section className="card form" aria-label={t('egress.title')}>
            <h2>{t('egress.title')}</h2>
            <p className="small muted">{t('egress.intro')}</p>
            {groups.length === 0 ? <p className="small">{t('egress.empty')}</p> : null}
            {groups.map(({ category, items }) => (
                <div key={category} data-testid={`egress-${category}`}>
                    <h3>{t(`egress.category.${category}`)}</h3>
                    <ul className="small">
                        {items.map((x) => (
                            <li key={x.id}>
                                <strong>{x.label}</strong>{' '}
                                {x.origin === null ? <em>{t('egress.local')}</em> : <code>{x.origin}</code>} ·{' '}
                                <span className={x.enabled ? undefined : 'muted'}>
                                    {t(x.enabled ? 'egress.enabled' : 'egress.disabled')}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
            {targets.some((x) => x.local) ? <p className="small muted">{t('egress.localNote')}</p> : null}
            <p className="small muted">{t('egress.dynamicNote')}</p>
        </section>
    );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { useI18n } from './i18n.js';

/** 自动抽取开启时在记忆页顶部提示,并提供一键关闭(计划 M3.x;ADR 0007 第 5.1 节)。 */
export function AutoExtractNotice({
    autoExtract,
    stopped,
    error,
    onTurnOff,
}: {
    autoExtract: boolean;
    stopped: boolean;
    error: string | null;
    onTurnOff: () => void;
}) {
    const { t } = useI18n();
    if (!autoExtract && !stopped) return null;
    return (
        <section className="card" data-testid="auto-extract-notice">
            {autoExtract ? (
                <div className="row spread">
                    <span>{t('memory.autoExtractOn')}</span>
                    <button type="button" className="danger" onClick={onTurnOff}>
                        {t('memory.autoExtractOff')}
                    </button>
                </div>
            ) : (
                <p className="small muted">{t('memory.autoExtractStopped')}</p>
            )}
            {error ? <p className="error">{error}</p> : null}
        </section>
    );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { useState } from 'react';
import { useI18n } from '../i18n.js';
import { capLines, MAX_VISIBLE_LINES, visibleText } from './sanitize.js';

export const MAIL_TEXT_TOOLS = ['mail.list', 'mail.search', 'mail.read', 'mail.summarize'];

/** 邮件结果:正文按纯文本显示,带「外部内容,不会被执行」提示;不加载图片,不渲染链接。 */
export function MailCard({ output }: { output: unknown }) {
    const { t } = useI18n();
    const [shown, setShown] = useState(MAX_VISIBLE_LINES);
    const content = (output as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') return null;
    const { lines, more } = capLines(content, shown);
    return (
        <div className="vis-card mail-card" data-testid="mail-card">
            <p className="small muted vis-untrusted">{t('vis.untrusted')}</p>
            <pre className="vis-text">{lines.map(visibleText).join('\n')}</pre>
            {more > 0 ? (
                <button type="button" className="link small" onClick={() => setShown(shown + MAX_VISIBLE_LINES)}>
                    {t('vis.more', { n: more })}
                </button>
            ) : null}
        </div>
    );
}

/** mail.draft 的草稿卡:收件人、主题;发送另有审批。 */
export function MailDraftCard({ output }: { output: unknown }) {
    const { t } = useI18n();
    const d = output as { to?: unknown; cc?: unknown; subject?: unknown } | null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    if (!d || typeof d.subject !== 'string') return null;
    const to = list(d.to);
    const cc = list(d.cc);
    return (
        <div className="vis-card mail-card" data-testid="mail-draft-card">
            <span className="risk-tag">{t('vis.mail.draft')}</span>
            <dl className="vis-fields small">
                <dt>{t('vis.mail.to')}</dt>
                <dd>{visibleText(to.join(', '))}</dd>
                {cc.length > 0 ? (
                    <>
                        <dt>{t('vis.mail.cc')}</dt>
                        <dd>{visibleText(cc.join(', '))}</dd>
                    </>
                ) : null}
                <dt>{t('vis.mail.subject')}</dt>
                <dd>{visibleText(d.subject)}</dd>
            </dl>
            <p className="small muted">{t('vis.mail.sendNeedsApproval')}</p>
        </div>
    );
}

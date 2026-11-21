// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面壳里的内置浏览器面板(ADR 0046 第 3、14 节):工具栏 + 一个占位元素。壳把独立的原生 webview 盖在占位元素之上;
// 这里只负责地址栏、前进后退、拦截提示,并把占位元素的位置同步给壳。网页内容永远不进入本页面的 DOM。
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type BrowserController, boundsOf, reasonKey } from './browser-panel.js';
import { Icon } from './Icon.js';
import { useI18n } from './i18n.js';

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function BrowserPanel({
    controller,
    fallback,
    pageUrl,
}: {
    controller: BrowserController;
    /** 面板里还没有页面时显示的内容(服务器抓取过的页面文字、或一句提示)。 */
    fallback: ReactNode;
    /** 服务器抓取的页面地址;有的话提供「在浏览器面板中打开」。 */
    pageUrl: string | null;
}) {
    const { t } = useI18n();
    const state = useSyncExternalStore(controller.subscribe, controller.getState);
    const viewRef = useRef<HTMLDivElement>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    // 把占位元素的位置交给控制器;大小变化与窗口缩放时同步给壳
    useEffect(() => {
        const element = viewRef.current;
        if (!element) return;
        const bounds = () => boundsOf(element.getBoundingClientRect());
        controller.attachView(bounds);
        const sync = () => void controller.sync();
        const observer = new ResizeObserver(sync);
        observer.observe(element);
        window.addEventListener('resize', sync);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', sync);
            controller.attachView(null);
        };
    }, [controller]);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        setEditing(false);
        if (text) void controller.go(text).catch(() => undefined);
    };

    const reason = (code: string | undefined) => t(reasonKey(code));
    const blockedText = state.blocked
        ? state.blocked.what === 'navigation'
            ? t('wb.browser.blocked.navigation', {
                  origin: state.blocked.origin ?? '',
                  reason: reason(state.blocked.reason),
              })
            : t(`wb.browser.blocked.${state.blocked.what}` as 'wb.browser.blocked.popup')
        : null;
    const errorText = state.error ? reason(state.error) : null;

    return (
        <div className="wb-browser">
            <div className="wb-browser-bar">
                <button
                    type="button"
                    disabled={!state.open}
                    aria-label={t('wb.browser.back')}
                    onClick={() => void controller.back()}
                >
                    <Icon name="back" size={16} />
                </button>
                <button
                    type="button"
                    disabled={!state.open}
                    aria-label={t('wb.browser.forward')}
                    onClick={() => void controller.forward()}
                >
                    <Icon name="fwd" size={16} />
                </button>
                <button
                    type="button"
                    disabled={!state.open}
                    aria-label={t('wb.browser.reload')}
                    onClick={() => void controller.reload()}
                >
                    <Icon name="refresh" size={16} />
                </button>
                <form className="wb-browser-address" onSubmit={submit}>
                    {editing || !state.open ? (
                        <input
                            type="text"
                            autoFocus={editing}
                            value={draft}
                            placeholder={t('wb.browser.addressPlaceholder')}
                            aria-label={t('wb.browser.address')}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => setEditing(false)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditing(false);
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="wb-browser-url"
                            title={state.url}
                            aria-label={t('wb.browser.address')}
                            onClick={() => {
                                setDraft(state.url);
                                setEditing(true);
                            }}
                        >
                            <Icon name="lock" size={16} />
                            <span>{hostOf(state.url)}</span>
                            {state.loading ? <span className="wb-spin" aria-hidden="true" /> : null}
                        </button>
                    )}
                </form>
                <button
                    type="button"
                    disabled={!state.open}
                    aria-label={t('wb.browser.close')}
                    onClick={() => void controller.close()}
                >
                    <Icon name="x" size={16} />
                </button>
            </div>
            {blockedText || errorText ? (
                <p className="wb-note wb-browser-alert" role="status">
                    {blockedText ?? errorText}
                </p>
            ) : null}
            <div ref={viewRef} className="wb-browser-view">
                {state.open ? null : (
                    <div className="wb-browser-idle">
                        {fallback}
                        {pageUrl ? (
                            <button
                                type="button"
                                className="link small"
                                onClick={() => void controller.go(pageUrl).catch(() => undefined)}
                            >
                                {t('wb.browser.openPage')}
                            </button>
                        ) : null}
                    </div>
                )}
            </div>
            <p className="wb-note wb-browser-foot">{t('wb.browser.subresources')}</p>
        </div>
    );
}

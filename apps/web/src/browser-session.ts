// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面壳里的浏览器会话:一个进程级的控制器,加上两件必须在整个登录期间一直在的事——
// 接收壳发来的页面事件;向服务器声明「我能截图、能用默认程序打开」并执行服务器请求的调用(ADR 0046 第 5、14 节)。
// 放在外壳(Shell)里调用,这样用户切到设置等页面时也不会丢事件。
import { useEffect } from 'react';
import { api } from './api.js';
import { BROWSER_EVENT, BrowserController, openWithShell, shellInvoke } from './browser-panel.js';

let instance: BrowserController | null | undefined;

/** 不在桌面壳里时为 null(纯网页与手机 PWA 没有可控制的浏览器,`browser.*` 的结果显示为文字卡片)。 */
export function browserController(): BrowserController | null {
    if (instance === undefined) {
        const invoke = shellInvoke();
        instance = invoke ? new BrowserController(invoke) : null;
    }
    return instance;
}

/** 请求截图的调用过期(服务器已放弃等待)就不再做。 */
export function isFresh(expiresAt: string, now = Date.now()): boolean {
    const at = Date.parse(expiresAt);
    return Number.isFinite(at) && at > now;
}

export function useBrowserShell(): void {
    useEffect(() => {
        const controller = browserController();
        if (!controller) return;
        const onEvent = (event: Event) => controller.handleEvent((event as CustomEvent<unknown>).detail);
        window.addEventListener(BROWSER_EVENT, onEvent);
        const connection = api.connectEvents({
            onEvent: () => undefined,
            capabilities: { browser: true, open: true },
            onClientCall: (call) => {
                if (!isFresh(call.expiresAt)) return;
                const run =
                    call.tool === 'system.open'
                        ? openWithShell(controller.invoke, call.target)
                        : controller.screenshot(call.url);
                void run.then((result) => api.clientCalls.result(call.callId, result)).catch(() => undefined);
            },
        });
        return () => {
            window.removeEventListener(BROWSER_EVENT, onEvent);
            connection.close();
        };
    }, []);
}

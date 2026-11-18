// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { useEffect, useState } from 'react';

/** 仅在生产构建中注册 service worker(开发服务器不缓存任何东西)。 */
export function registerServiceWorker(): void {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
}

/** 浏览器当前是否在线。 */
export function useOnline(): boolean {
    const [online, setOnline] = useState(() => navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(true);
        const off = () => setOnline(false);
        window.addEventListener('online', on);
        window.addEventListener('offline', off);
        return () => {
            window.removeEventListener('online', on);
            window.removeEventListener('offline', off);
        };
    }, []);
    return online;
}

interface InstallPromptEvent extends Event {
    prompt: () => Promise<void>;
}

/** 捕获 beforeinstallprompt;canInstall 为真时可调用 install() 弹出系统安装对话框。 */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<void> } {
    const [event, setEvent] = useState<InstallPromptEvent | null>(null);
    useEffect(() => {
        const onPrompt = (e: Event) => {
            e.preventDefault();
            setEvent(e as InstallPromptEvent);
        };
        const onInstalled = () => setEvent(null);
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);
    return {
        canInstall: event !== null,
        install: async () => {
            if (!event) return;
            await event.prompt();
            setEvent(null);
        },
    };
}

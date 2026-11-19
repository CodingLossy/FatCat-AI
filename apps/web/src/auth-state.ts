// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 启动 / 恢复联网时判断登录状态(含离线缓存与设备令牌过期的处理),依赖都注入,方便单测。
import { FatCatNetworkError } from '@fatcat-ai/client';
import type { AuthStatus, Settings } from '@fatcat-ai/shared';

export interface AuthDeps {
    status(): Promise<AuthStatus>;
    settings(): Promise<Settings>;
    isOffline(error: unknown): boolean;
    device: {
        isPaired(): boolean;
        /** 刷新设备令牌:成功 true;服务器拒绝(设备已吊销)时已清掉本机令牌并返回 false;网络错误返回 false 且令牌保留。 */
        refresh(): Promise<boolean>;
    };
    cache: {
        remember(settings: Settings): void;
        clear(): Promise<void>;
        offlineStartup(): Promise<Settings | null>;
    };
}

export interface AuthState {
    status: AuthStatus;
    settings: Settings | null;
}

export async function resolveAuth(deps: AuthDeps): Promise<AuthState> {
    try {
        let status = await deps.status();
        // /auth/status 是公开端点:过期的设备 access 令牌得到的是 200 未登录,而不是 401,
        // 所以不会触发自动刷新。已配对的设备先用 refresh 令牌换一次再判断,否则离线超过 15 分钟的手机会被误当成已登出。
        if (!status.authenticated && deps.device.isPaired()) {
            if (await deps.device.refresh()) status = await deps.status();
            // refresh 因网络问题失败、设备还在:按离线处理,既不清缓存也不进登录页
            else if (deps.device.isPaired()) throw new FatCatNetworkError('Cannot refresh the device token');
        }
        const settings = status.authenticated ? await deps.settings() : null;
        if (settings) deps.cache.remember(settings);
        // 服务器明确说未登录(登出、会话过期、设备被吊销):缓存不该留在这台设备上
        else await deps.cache.clear();
        return { status, settings };
    } catch (error) {
        // 连不上服务器:登录过的设备只读地显示离线缓存(ADR 0045 第 2 节),恢复联网后会重新确认登录状态
        const settings = deps.isOffline(error) ? await deps.cache.offlineStartup() : null;
        if (!settings) throw error;
        return { status: { initialized: true, authenticated: true }, settings };
    }
}

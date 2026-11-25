// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 当前账户是不是管理员(ADR 0053 第 4、6 节):决定显示哪些「只有管理员能开」的入口。
// 只用于显示;服务端每条管理员路由自己再检查角色。老服务器不返回 role,按管理员处理(1.0 只有一个主人)。
import { useEffect, useState } from 'react';
import { api } from './api.js';

let cached: Promise<boolean> | null = null;

/** 同一页面里只问一次;退出登录后页面会重新加载,缓存随之清空。 */
function loadIsAdmin(): Promise<boolean> {
    cached ??= api.auth.me().then(
        (me) => me.role !== 'member',
        () => {
            cached = null; // 网络错误下次再试
            return true;
        },
    );
    return cached;
}

/** 加载中为 null;调用方在 null 时按「先不显示管理员入口」处理,避免成员看到一闪而过的按钮。 */
export function useIsAdmin(): boolean | null {
    const [admin, setAdmin] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        void loadIsAdmin().then((value) => alive && setAdmin(value));
        return () => {
            alive = false;
        };
    }, []);
    return admin;
}

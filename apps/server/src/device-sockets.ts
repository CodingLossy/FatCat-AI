// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设备吊销要立即生效(ADR 0045):用设备令牌建立的 WebSocket 登记在这里,
// 设备被吊销(业主吊销、设备自己登出、refresh 重放)时由 devices 路由关掉这台设备的所有连接。
// 设备 id 是 ULID,全进程唯一,所以用进程级单例即可,不必在路由与 WebSocket 之间传依赖。

export const DEVICE_REVOKED_CLOSE_CODE = 4401;

interface Closable {
    close(code: number, reason: string): void;
}

const sockets = new Map<string, Set<Closable>>();

/** 登记一个设备的连接,返回注销函数(连接关闭时调用)。 */
export function registerDeviceSocket(deviceId: string, socket: Closable): () => void {
    const set = sockets.get(deviceId) ?? new Set<Closable>();
    set.add(socket);
    sockets.set(deviceId, set);
    return () => {
        set.delete(socket);
        if (set.size === 0 && sockets.get(deviceId) === set) sockets.delete(deviceId);
    };
}

/** 关掉某台设备已建立的全部 WebSocket;返回关了几个。 */
export function closeDeviceSockets(deviceId: string): number {
    const set = sockets.get(deviceId);
    if (!set) return 0;
    sockets.delete(deviceId);
    for (const socket of set) socket.close(DEVICE_REVOKED_CLOSE_CODE, 'device revoked');
    return set.size;
}

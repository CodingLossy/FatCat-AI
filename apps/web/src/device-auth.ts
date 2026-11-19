// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 手机(已配对设备)的令牌存取与刷新(ADR 0045)。
// 令牌放在 localStorage:access 15 分钟有效,refresh 90 天并且每次使用都轮换;
// 两个标签页同时拿同一个 refresh 令牌去换会被服务器判成重放而吊销设备,所以刷新用 Web Locks 串行化。
import { FatCatApiError } from '@fatcat-ai/client';
import type { DeviceTokens } from '@fatcat-ai/shared';

const KEY = 'fatcat.device';
/** access 令牌到期前这么久就提前刷新,避免请求中途过期。 */
const REFRESH_MARGIN_MS = 60_000;

export interface StoredDevice {
    deviceId: string;
    accessToken: string;
    accessExpiresAt: string;
    refreshToken: string;
    refreshExpiresAt: string;
}

export interface DeviceStore {
    load(): StoredDevice | null;
    save(tokens: DeviceTokens): void;
    clear(): void;
}

function isStored(value: unknown): value is StoredDevice {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return ['deviceId', 'accessToken', 'accessExpiresAt', 'refreshToken', 'refreshExpiresAt'].every(
        (k) => typeof v[k] === 'string',
    );
}

export function localDeviceStore(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): DeviceStore {
    // 隐私模式等场景下访问 localStorage 可能抛错:此时退化为只在内存里保存(关掉页面就要重新配对)
    let memory: StoredDevice | null = null;
    const backend = (() => {
        try {
            return storage ?? window.localStorage;
        } catch {
            return null;
        }
    })();
    return {
        load() {
            try {
                const raw = backend?.getItem(KEY);
                if (raw) {
                    const parsed: unknown = JSON.parse(raw);
                    if (isStored(parsed)) return parsed;
                }
            } catch {
                // 损坏的数据按没有处理
            }
            return memory;
        },
        save(tokens) {
            const stored: StoredDevice = {
                deviceId: tokens.device.id,
                accessToken: tokens.accessToken,
                accessExpiresAt: tokens.accessExpiresAt,
                refreshToken: tokens.refreshToken,
                refreshExpiresAt: tokens.refreshExpiresAt,
            };
            memory = stored;
            try {
                backend?.setItem(KEY, JSON.stringify(stored));
            } catch {
                // 存不下就只留内存
            }
        },
        clear() {
            memory = null;
            try {
                backend?.removeItem(KEY);
            } catch {
                // 忽略
            }
        },
    };
}

type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

function browserLock(): Lock {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks ? (name, fn) => locks.request(name, fn) : (_name, fn) => fn();
}

export interface DeviceAuthOptions {
    store: DeviceStore;
    /** 用 refresh 令牌换新令牌;测试里可以替换。 */
    exchange: (refreshToken: string) => Promise<DeviceTokens>;
    now?: () => number;
    lock?: Lock;
}

export class DeviceAuth {
    private readonly store: DeviceStore;
    private readonly exchange: DeviceAuthOptions['exchange'];
    private readonly now: () => number;
    private readonly lock: Lock;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: DeviceAuthOptions) {
        this.store = options.store;
        this.exchange = options.exchange;
        this.now = options.now ?? Date.now;
        this.lock = options.lock ?? browserLock();
    }

    /** 本机是否是已配对设备(用 Bearer 令牌而不是 Cookie 访问)。 */
    isPaired(): boolean {
        return this.store.load() !== null;
    }

    accessToken(): string | undefined {
        return this.store.load()?.accessToken;
    }

    /** 配对成功后保存令牌,并安排下一次提前刷新。 */
    adopt(tokens: DeviceTokens): void {
        this.store.save(tokens);
        this.schedule();
    }

    forget(): void {
        this.store.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    /**
     * 刷新令牌。进入锁后重新读存储:如果别的标签页已经刷新过(access 令牌变了),直接用它,不再用旧的 refresh。
     * 服务器明确拒绝(401)说明设备已被吊销或 refresh 过期,清除本机令牌;网络错误则保留,稍后再试。
     */
    refresh(staleAccess?: string): Promise<boolean> {
        return this.lock('fatcat-device-refresh', async () => {
            const current = this.store.load();
            if (!current) return false;
            if (staleAccess !== undefined && current.accessToken !== staleAccess) return true;
            if (Date.parse(current.refreshExpiresAt) <= this.now()) {
                this.forget();
                return false;
            }
            try {
                this.store.save(await this.exchange(current.refreshToken));
                this.schedule();
                return true;
            } catch (error) {
                if (error instanceof FatCatApiError && (error.status === 401 || error.status === 403)) this.forget();
                return false;
            }
        });
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        const current = this.store.load();
        if (!current) return;
        const wait = Math.max(5_000, Date.parse(current.accessExpiresAt) - this.now() - REFRESH_MARGIN_MS);
        this.timer = setTimeout(
            () => {
                void this.refresh(current.accessToken);
            },
            Math.min(wait, 2 ** 31 - 1),
        );
    }

    /** 页面启动时调用:已经过期或快过期的 access 令牌先刷新一次,再恢复定时刷新。 */
    async start(): Promise<void> {
        const current = this.store.load();
        if (!current) return;
        if (Date.parse(current.accessExpiresAt) - this.now() < REFRESH_MARGIN_MS) await this.refresh();
        else this.schedule();
    }
}

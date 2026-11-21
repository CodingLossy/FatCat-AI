// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 内置浏览器面板的前端控制器(ADR 0046 第 3、14 节)。只在桌面壳里有用:壳把子 webview 盖在界面上的占位元素之上,
// 这里负责把占位元素的位置告诉壳、转发导航命令、接收壳发来的页面事件,并执行服务器请求的截图。
// 纯逻辑,不依赖 React;和壳之间的通道(invoke)由外部注入,测试里换成假的。
import type { ClientCallFailureCode, ClientCallResult, OpenTarget } from '@fatcat-ai/shared';

export const BROWSER_EVENT = 'fatcat-browser';

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriWindow {
    __TAURI_INTERNALS__?: { invoke?: unknown };
}

/** 本页面是不是跑在桌面壳里(壳只给本应用自己的来源注入可用的 IPC,见 capabilities/main.json)。 */
export function shellInvoke(win: TauriWindow = window as unknown as TauriWindow): Invoke | null {
    const invoke = win.__TAURI_INTERNALS__?.invoke;
    return typeof invoke === 'function' ? (invoke.bind(win.__TAURI_INTERNALS__) as Invoke) : null;
}

export type BlockedKind = 'navigation' | 'popup' | 'download';

/** 壳发来的页面事件(壳用 `fatcat-browser` 自定义事件分发,detail 是不可信的数据,这里逐项校验)。 */
export type BrowserEvent =
    | { type: 'navigating' | 'loading' | 'loaded'; url: string }
    | { type: 'blocked'; what: BlockedKind; reason?: string; origin?: string };

const text = (value: unknown, max = 2048): string | null =>
    typeof value === 'string' && value.length <= max ? value : null;

export function parseBrowserEvent(detail: unknown): BrowserEvent | null {
    if (typeof detail !== 'object' || detail === null) return null;
    const d = detail as Record<string, unknown>;
    if (d.type === 'navigating' || d.type === 'loading' || d.type === 'loaded') {
        const url = text(d.url);
        return url === null ? null : { type: d.type, url };
    }
    if (d.type === 'blocked' && (d.what === 'navigation' || d.what === 'popup' || d.what === 'download')) {
        const reason = text(d.reason, 40);
        const origin = text(d.origin, 300);
        return {
            type: 'blocked',
            what: d.what,
            ...(reason ? { reason } : {}),
            ...(origin ? { origin } : {}),
        };
    }
    return null;
}

export interface PanelState {
    /** 壳里是否已经有这个子 webview。 */
    open: boolean;
    url: string;
    loading: boolean;
    /** 最近一次被拦截的动作;用户再次导航时清除。 */
    blocked: { what: BlockedKind; reason?: string; origin?: string } | null;
    /** 壳返回的稳定错误码(不可用、被策略拒绝等);用户再次操作时清除。 */
    error: string | null;
}

export const INITIAL_PANEL: PanelState = { open: false, url: '', loading: false, blocked: null, error: null };

export function reduceBrowserEvent(state: PanelState, event: BrowserEvent): PanelState {
    switch (event.type) {
        case 'navigating':
            return { ...state, url: event.url, loading: true, blocked: null, error: null };
        case 'loading':
            return { ...state, url: event.url, loading: true };
        case 'loaded':
            return { ...state, url: event.url, loading: false };
        case 'blocked': {
            const { what, reason, origin } = event;
            return { ...state, blocked: { what, ...(reason ? { reason } : {}), ...(origin ? { origin } : {}) } };
        }
    }
}

/** 占位元素的矩形 → 壳里子 webview 的位置(主界面铺满窗口,视口坐标就是窗口里的逻辑坐标)。 */
export function boundsOf(rect: { left: number; top: number; width: number; height: number }): Bounds {
    return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
    };
}

/** 壳返回的错误(字符串码)→ 界面用的稳定码;没见过的一律 failed。 */
const KNOWN_ERRORS = new Set([
    'bad_url',
    'bad_scheme',
    'credentials_in_url',
    'ip_literal',
    'internal_host',
    'unsupported',
    'timeout',
    'too_large',
]);
export function errorCode(error: unknown): string {
    const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    return KNOWN_ERRORS.has(raw) ? raw : 'failed';
}

/** 壳或策略给出的原因码 → 界面文字的键;没见过的显示成「已拦截」。 */
const REASON_KEYS = {
    bad_url: 'wb.browser.reason.bad_url',
    bad_scheme: 'wb.browser.reason.bad_scheme',
    credentials_in_url: 'wb.browser.reason.credentials_in_url',
    ip_literal: 'wb.browser.reason.ip_literal',
    internal_host: 'wb.browser.reason.internal_host',
    unsupported: 'wb.browser.reason.unsupported',
    timeout: 'wb.browser.reason.timeout',
    too_large: 'wb.browser.reason.too_large',
    failed: 'wb.browser.reason.failed',
} as const;
export function reasonKey(
    code: string | undefined,
): (typeof REASON_KEYS)[keyof typeof REASON_KEYS] | 'wb.browser.reason.unknown' {
    return code !== undefined && Object.hasOwn(REASON_KEYS, code)
        ? REASON_KEYS[code as keyof typeof REASON_KEYS]
        : 'wb.browser.reason.unknown';
}

/** 壳的错误码 → 核心的失败码(POST /tool-calls/{id}/result)。 */
export function failureFor(code: string): ClientCallFailureCode {
    switch (code) {
        case 'bad_url':
        case 'bad_scheme':
        case 'credentials_in_url':
        case 'ip_literal':
        case 'internal_host':
            return 'blocked';
        case 'unsupported':
            return 'unsupported';
        case 'timeout':
            return 'timeout';
        case 'too_large':
            return 'too_large';
        default:
            return 'failed';
    }
}

interface ShellShot {
    mimeType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    data: string;
}

function isShot(value: unknown): value is ShellShot {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        (v.mimeType === 'image/png' || v.mimeType === 'image/jpeg') &&
        typeof v.width === 'number' &&
        typeof v.height === 'number' &&
        typeof v.data === 'string'
    );
}

export interface ControllerOptions {
    /** 等页面加载完成的最长时间(毫秒)。 */
    loadTimeoutMs?: number;
    /** 等界面把面板显示出来(占位元素挂上)的最长时间(毫秒)。 */
    viewTimeoutMs?: number;
}

export class BrowserController {
    private state: PanelState = INITIAL_PANEL;
    private readonly listeners = new Set<() => void>();
    private view: (() => Bounds) | null = null;
    private visible = true;
    private loadedWaiters: Array<() => void> = [];
    private viewWaiters: Array<() => void> = [];
    /** 界面调用:把浏览器面板切到前台(服务器要截图时,面板可能在别的标签后面)。 */
    private requestPanel: () => void = () => undefined;
    onRequestPanel(handler: () => void): void {
        this.requestPanel = handler;
    }

    constructor(
        readonly invoke: Invoke,
        private readonly options: ControllerOptions = {},
    ) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    getState = (): PanelState => this.state;

    private set(next: PanelState): void {
        this.state = next;
        for (const listener of this.listeners) listener();
    }

    /** 壳发来的页面事件。 */
    handleEvent(detail: unknown): void {
        const event = parseBrowserEvent(detail);
        if (!event) return;
        this.set(reduceBrowserEvent(this.state, event));
        if (event.type === 'loaded') this.loadedWaiters.splice(0).forEach((resolve) => resolve());
    }

    /** 面板挂上 / 卸下:getBounds 给出占位元素当前的位置。卸下时把原生 webview 藏起来,页面保留。 */
    attachView(getBounds: (() => Bounds) | null): void {
        this.view = getBounds;
        if (getBounds) {
            this.viewWaiters.splice(0).forEach((resolve) => resolve());
            if (this.state.open) void this.sync();
        } else if (this.state.open) {
            void this.invoke('browser_set_visible', { visible: false }).catch(() => undefined);
        }
    }

    /** 命令面板、搜索下拉等浮层出现时藏起原生 webview(原生视图总是盖在界面之上)。 */
    setHidden(hidden: boolean): void {
        const visible = !hidden;
        if (visible === this.visible) return;
        this.visible = visible;
        if (this.state.open && this.view) void this.invoke('browser_set_visible', { visible }).catch(() => undefined);
    }

    /** 占位元素的位置或大小变了。 */
    async sync(): Promise<void> {
        if (!this.state.open || !this.view) return;
        try {
            await this.invoke('browser_set_bounds', { bounds: this.view() });
            await this.invoke('browser_set_visible', { visible: this.visible });
        } catch {
            // 面板已被关闭或窗口正在销毁时忽略
        }
    }

    /** 打开或导航:面板没有显示时先请求界面显示它。返回壳规范化之后的地址。 */
    async go(url: string): Promise<string> {
        this.set({ ...this.state, error: null, blocked: null });
        try {
            if (!this.view) await this.waitForView();
            const bounds = this.view!();
            const target = (await this.invoke('browser_open', { url, bounds })) as string;
            this.set({ ...this.state, open: true, url: target, loading: true });
            await this.invoke('browser_set_visible', { visible: this.visible }).catch(() => undefined);
            return target;
        } catch (error) {
            const code = errorCode(error);
            this.set({ ...this.state, error: code });
            throw new Error(code, { cause: error });
        }
    }

    private async command(name: string, args?: Record<string, unknown>): Promise<void> {
        try {
            await this.invoke(name, args);
        } catch (error) {
            this.set({ ...this.state, error: errorCode(error) });
        }
    }

    back = () => this.command('browser_back');
    forward = () => this.command('browser_forward');
    reload = () => this.command('browser_reload');

    async close(): Promise<void> {
        await this.invoke('browser_close').catch(() => undefined);
        this.set(INITIAL_PANEL);
    }

    private waitForView(): Promise<void> {
        if (this.view) return Promise.resolve();
        this.requestPanel();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), this.options.viewTimeoutMs ?? 3000);
            this.viewWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    private waitForLoaded(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.loadedWaiters = this.loadedWaiters.filter((w) => w !== done);
                reject(new Error('timeout'));
            }, this.options.loadTimeoutMs ?? 15_000);
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            this.loadedWaiters.push(done);
        });
    }

    /** 服务器请求的截图:让面板加载这个地址,等加载完成,再截图。任何失败都变成稳定的失败码,不抛出。 */
    async screenshot(url: string): Promise<ClientCallResult> {
        try {
            const loaded = this.waitForLoaded();
            // 先登记等待再导航,避免加载太快错过事件;导航失败时丢弃这个等待
            loaded.catch(() => undefined);
            await this.go(url);
            await loaded;
            const shot = await this.invoke('browser_screenshot');
            if (!isShot(shot)) return { ok: false, code: 'failed' };
            return { ok: true, mimeType: shot.mimeType, width: shot.width, height: shot.height, data: shot.data };
        } catch (error) {
            const code = errorCode(error);
            return { ok: false, code: failureFor(code) };
        }
    }
}

/** 已经核心校验、用户批准的 system.open:交给壳(壳会再检查一次),失败变成稳定的失败码,不抛出。 */
export async function openWithShell(invoke: Invoke, target: OpenTarget): Promise<ClientCallResult> {
    try {
        await invoke('system_open', { target });
        return { ok: true, opened: true };
    } catch (error) {
        const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
        return raw === 'blocked' || raw === 'not_found'
            ? { ok: false, code: 'blocked' }
            : { ok: false, code: 'failed' };
    }
}

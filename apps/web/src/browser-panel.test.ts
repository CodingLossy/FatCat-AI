// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    BrowserController,
    boundsOf,
    errorCode,
    failureFor,
    INITIAL_PANEL,
    parseBrowserEvent,
    reasonKey,
    reduceBrowserEvent,
    shellInvoke,
} from './browser-panel.js';

describe('壳发来的页面事件', () => {
    it('只接受已知的形状,detail 里的其他东西一律丢弃;过长的字段整条丢弃', () => {
        expect(parseBrowserEvent({ type: 'loaded', url: 'https://a.example/' })).toEqual({
            type: 'loaded',
            url: 'https://a.example/',
        });
        expect(parseBrowserEvent({ type: 'blocked', what: 'popup', origin: 'https://x.example', evil: '<b>' })).toEqual(
            { type: 'blocked', what: 'popup', origin: 'https://x.example' },
        );
        expect(parseBrowserEvent({ type: 'loaded', url: 5 })).toBeNull();
        expect(parseBrowserEvent({ type: 'loaded', url: 'x'.repeat(3000) })).toBeNull();
        expect(parseBrowserEvent({ type: 'blocked', what: 'camera' })).toBeNull();
        expect(parseBrowserEvent({ type: 'something-else' })).toBeNull();
        expect(parseBrowserEvent('loaded')).toBeNull();
    });

    it('导航清除上一次的拦截提示;拦截只记下来源与原因', () => {
        let state = reduceBrowserEvent(INITIAL_PANEL, {
            type: 'blocked',
            what: 'navigation',
            reason: 'ip_literal',
            origin: 'https://127.0.0.1',
        });
        expect(state.blocked).toEqual({ what: 'navigation', reason: 'ip_literal', origin: 'https://127.0.0.1' });
        state = reduceBrowserEvent(state, { type: 'navigating', url: 'https://a.example/' });
        expect(state).toMatchObject({ url: 'https://a.example/', loading: true, blocked: null });
        expect(reduceBrowserEvent(state, { type: 'loaded', url: 'https://a.example/' }).loading).toBe(false);
    });
});

describe('位置与错误码', () => {
    it('矩形取整且至少 1×1;壳的错误码映射成核心的失败码,没见过的归为 failed', () => {
        expect(boundsOf({ left: 10.4, top: 20.6, width: 300.2, height: 0 })).toEqual({
            x: 10,
            y: 21,
            width: 300,
            height: 1,
        });
        expect(errorCode('ip_literal')).toBe('ip_literal');
        expect(errorCode(new Error('weird'))).toBe('failed');
        expect(failureFor('internal_host')).toBe('blocked');
        expect(failureFor('unsupported')).toBe('unsupported');
        expect(failureFor('failed')).toBe('failed');
        expect(reasonKey('ip_literal')).toBe('wb.browser.reason.ip_literal');
        expect(reasonKey('constructor')).toBe('wb.browser.reason.unknown');
        expect(reasonKey(undefined)).toBe('wb.browser.reason.unknown');
    });

    it('只有壳注入了 invoke 才算桌面壳', () => {
        expect(shellInvoke({})).toBeNull();
        expect(shellInvoke({ __TAURI_INTERNALS__: {} })).toBeNull();
        const calls: string[] = [];
        const invoke = shellInvoke({
            __TAURI_INTERNALS__: { invoke: (c: string) => Promise.resolve(void calls.push(c)) },
        });
        void invoke?.('browser_close');
        expect(calls).toEqual(['browser_close']);
    });
});

describe('服务器请求的截图', () => {
    const view = () => ({ x: 1, y: 2, width: 300, height: 200 });

    function setup(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
        const calls: string[] = [];
        const controller = new BrowserController(
            (command, args) => {
                calls.push(command);
                const handler = handlers[command];
                if (!handler) return Promise.resolve(undefined);
                try {
                    return Promise.resolve(handler(args));
                } catch (error) {
                    return Promise.reject(error);
                }
            },
            { loadTimeoutMs: 30, viewTimeoutMs: 30 },
        );
        return { controller, calls };
    }

    it('面板挂着时:导航、等加载完成、截图,结果按核心的格式返回', async () => {
        const { controller, calls } = setup({
            browser_open: () => 'https://a.example/',
            browser_screenshot: () => ({ mimeType: 'image/jpeg', width: 300, height: 200, data: '/9j/AAAA' }),
        });
        controller.attachView(view);
        const pending = controller.screenshot('https://a.example/');
        setTimeout(() => controller.handleEvent({ type: 'loaded', url: 'https://a.example/' }), 5);
        await expect(pending).resolves.toEqual({
            ok: true,
            mimeType: 'image/jpeg',
            width: 300,
            height: 200,
            data: '/9j/AAAA',
        });
        expect(calls).toContain('browser_open');
        expect(calls).toContain('browser_screenshot');
        expect(controller.getState()).toMatchObject({ open: true, url: 'https://a.example/' });
    });

    it('壳拒绝地址、不支持截图、页面一直没加载完,都变成稳定的失败码而不是抛出', async () => {
        const blocked = setup({
            browser_open: () => {
                throw 'ip_literal';
            },
        });
        blocked.controller.attachView(view);
        await expect(blocked.controller.screenshot('https://127.0.0.1/')).resolves.toEqual({
            ok: false,
            code: 'blocked',
        });
        expect(blocked.controller.getState().error).toBe('ip_literal');

        const unsupported = setup({
            browser_open: () => 'https://a.example/',
            browser_screenshot: () => {
                throw 'unsupported';
            },
        });
        unsupported.controller.attachView(view);
        const pending = unsupported.controller.screenshot('https://a.example/');
        setTimeout(() => unsupported.controller.handleEvent({ type: 'loaded', url: 'https://a.example/' }), 5);
        await expect(pending).resolves.toEqual({ ok: false, code: 'unsupported' });

        const slow = setup({ browser_open: () => 'https://a.example/' });
        slow.controller.attachView(view);
        await expect(slow.controller.screenshot('https://a.example/')).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });
    });

    it('面板没有显示时先请求界面切到浏览器;一直没显示就以超时失败', async () => {
        const { controller } = setup({});
        let asked = 0;
        controller.onRequestPanel(() => {
            asked += 1;
        });
        await expect(controller.screenshot('https://a.example/')).resolves.toEqual({ ok: false, code: 'timeout' });
        expect(asked).toBe(1);
    });
});

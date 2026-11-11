// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音指示器显示的状态(ADR 0021 第 6、7 节):以最后一个 assistant-state 为准,不做优先级合并;
// 补发得到的、30 秒前的状态按 idle;文字变化去抖 150 ms,避免 thinking / executing 快速交替时闪烁。
import { type AssistantState, type EventEnvelope, STALE_ASSISTANT_STATE_MS } from '@fatcat-ai/shared';

export interface ShownState {
    state: AssistantState;
    /** 服务器给的文字;旧服务器没有时为 null,由界面按 state 用默认文字。 */
    label: string | null;
    sessionId: string | null;
}

export const IDLE: ShownState = { state: 'idle', label: null, sessionId: null };
export const STATE_DEBOUNCE_MS = 150;

/** 把一个事件折算进当前状态;不是 assistant-state 的事件不改变状态。 */
export function reduceAssistantState(current: ShownState, envelope: EventEnvelope, now: number): ShownState {
    const event = envelope.event;
    if (event.type !== 'assistant-state') return current;
    if (now - Date.parse(envelope.at) > STALE_ASSISTANT_STATE_MS) return IDLE;
    return { state: event.state, label: event.label ?? null, sessionId: envelope.sessionId };
}

/** 去抖:状态稳定 delay 毫秒后才交给 show;同一状态重复到达不重新计时。 */
export function createDebouncer(
    show: (state: ShownState) => void,
    delay = STATE_DEBOUNCE_MS,
    // 用箭头函数包一层:浏览器里以 timers.set(...) 调用原生 setTimeout 会报 Illegal invocation
    timers: {
        set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
        clear: (timer: ReturnType<typeof setTimeout>) => void;
    } = { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) },
) {
    let pending: ShownState | null = null;
    let shown: ShownState = IDLE;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const same = (a: ShownState, b: ShownState) => a.state === b.state && a.label === b.label;
    return {
        push(next: ShownState) {
            if (pending ? same(pending, next) : same(shown, next)) return;
            if (timer !== null) timers.clear(timer);
            pending = next;
            timer = timers.set(() => {
                timer = null;
                if (!pending) return;
                shown = pending;
                pending = null;
                show(shown);
            }, delay);
        },
        dispose() {
            if (timer !== null) timers.clear(timer);
            timer = null;
        },
    };
}

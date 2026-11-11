// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音状态的 WebSocket 连接:接收 assistant-state(服务器发的 thinking / executing,以及任一端上报的
// listening / speaking),并上报本端的收音 / 朗读(ADR 0021 第 6 节)。
import type { EventConnection } from '@fatcat-ai/client';
import type { VoiceStateReport } from '@fatcat-ai/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { createDebouncer, IDLE, reduceAssistantState, type ShownState } from './voice-state.js';

export function useAssistantState(): {
    shown: ShownState;
    report: (report: VoiceStateReport) => void;
} {
    const [shown, setShown] = useState<ShownState>(IDLE);
    const connection = useRef<EventConnection | null>(null);

    useEffect(() => {
        let current = IDLE;
        const debouncer = createDebouncer(setShown);
        try {
            connection.current = api.connectEvents({
                onEvent: (envelope) => {
                    const next = reduceAssistantState(current, envelope, Date.now());
                    if (next === current) return;
                    current = next;
                    debouncer.push(next);
                },
            });
        } catch {
            connection.current = null;
        }
        return () => {
            debouncer.dispose();
            connection.current?.close();
            connection.current = null;
        };
    }, []);

    const report = useCallback((r: VoiceStateReport) => connection.current?.reportVoiceState(r), []);
    return { shown, report };
}

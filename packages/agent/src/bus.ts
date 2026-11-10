// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EventEnvelope } from '@fatcat-ai/shared';

/** runId 为 null 表示与运行无关的事件。 */
export type EventListener = (envelope: EventEnvelope, runId: string | null) => void;

/**
 * 进程内事件总线:按 owner 广播已持久化的事件,供 SSE 与 WebSocket 推送(ADR 0004 第 5 节)。
 * 事件先写库再广播,所以订阅者错过的事件总能从库中补发。
 */
export class EventBus {
    private readonly listeners = new Map<string, Set<EventListener>>();

    subscribe(ownerId: string, listener: EventListener): () => void {
        let set = this.listeners.get(ownerId);
        if (!set) {
            set = new Set();
            this.listeners.set(ownerId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) this.listeners.delete(ownerId);
        };
    }

    publish(ownerId: string, envelope: EventEnvelope, runId: string | null = null): void {
        for (const listener of [...(this.listeners.get(ownerId) ?? [])]) {
            try {
                listener(envelope, runId);
            } catch {
                // 单个订阅者出错不影响其他订阅者与运行本身
            }
        }
    }

    listenerCount(ownerId: string): number {
        return this.listeners.get(ownerId)?.size ?? 0;
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「文件变化」触发器(ADR 0035 第 2 节):只监听已授权目录;每个目录一个 fs.watch,按任务去抖并合并路径。
// 不加依赖;fs.watch 的 recursive 在 Windows 与 macOS 上原生支持,Linux 上 Node 24 也支持。
import { watch, type FSWatcher } from 'node:fs';
import type { Repositories, TaskRecord } from '@fatcat-ai/storage';

export const MAX_WATCHED_ROOTS = 20;
const DEBOUNCE_MS = 5000;
const MAX_NAMES = 50;

export interface FileWatcher {
    /** 按当前的任务重新建立监听(任务或授权目录改变后调用)。 */
    sync(): void;
    stop(): void;
}

export function createFileWatcher(options: {
    repos: Repositories;
    /** 去抖结束后调用:note 是不可信的文件名列表。 */
    onChange: (task: TaskRecord, note: string) => void;
    onError: (error: unknown) => void;
    debounceMs?: number;
    /** 测试用:替换 fs.watch。 */
    watchFn?: typeof watch;
}): FileWatcher {
    const watchFn = options.watchFn ?? watch;
    const watchers = new Map<
        string,
        { watcher: FSWatcher; names: Set<string>; timer: ReturnType<typeof setTimeout> | null; taskIds: Set<string> }
    >();

    function close(path: string): void {
        const entry = watchers.get(path);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.watcher.close();
        watchers.delete(path);
    }

    return {
        sync() {
            const wanted = new Map<string, Set<string>>();
            for (const task of options.repos.tasks.listActive()) {
                const trigger = task.trigger;
                if (trigger.kind !== 'file_changed') continue;
                const root = options.repos.fsRoots.list(task.ownerId).find((r) => r.id === trigger.rootId);
                if (!root) continue;
                const ids = wanted.get(root.path) ?? new Set<string>();
                ids.add(task.id);
                wanted.set(root.path, ids);
            }
            for (const path of [...watchers.keys()]) if (!wanted.has(path)) close(path);
            for (const [path, ids] of wanted) {
                const existing = watchers.get(path);
                if (existing) {
                    existing.taskIds = ids;
                    continue;
                }
                if (watchers.size >= MAX_WATCHED_ROOTS) {
                    options.onError(new Error(`too many watched directories (max ${MAX_WATCHED_ROOTS})`));
                    continue;
                }
                try {
                    const entry = {
                        watcher: watchFn(path, { recursive: true, persistent: false }, (_event, name) => {
                            if (entry.names.size < MAX_NAMES && name) entry.names.add(String(name).slice(0, 200));
                            if (entry.timer) return;
                            entry.timer = setTimeout(() => {
                                entry.timer = null;
                                const note = `Files changed: ${[...entry.names].join(', ')}`;
                                entry.names.clear();
                                // 触发前重新核对:任务仍启用、授权目录仍在;目录被撤销就关闭监听(ADR 0035 第 2 节)
                                let live = 0;
                                for (const id of entry.taskIds) {
                                    const task = options.repos.tasks.getById(id);
                                    if (!task || !task.enabled || task.status !== 'active') continue;
                                    const trigger = task.trigger;
                                    if (trigger.kind !== 'file_changed') continue;
                                    const root = options.repos.fsRoots
                                        .list(task.ownerId)
                                        .find((r) => r.id === trigger.rootId);
                                    if (!root || root.path !== path) continue;
                                    live++;
                                    options.onChange(task, note);
                                }
                                if (live === 0) close(path);
                            }, options.debounceMs ?? DEBOUNCE_MS);
                            entry.timer.unref?.();
                        }),
                        names: new Set<string>(),
                        timer: null as ReturnType<typeof setTimeout> | null,
                        taskIds: ids,
                    };
                    entry.watcher.on('error', (error) => {
                        options.onError(error);
                        close(path);
                    });
                    watchers.set(path, entry);
                } catch (error) {
                    options.onError(error);
                }
            }
        },
        stop() {
            for (const path of [...watchers.keys()]) close(path);
        },
    };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目索引 v1(知识地图数据层,ADR 0003、ADR 0012):提供者、同步与 items.* 工具。
export { filesProvider, FILES_ROOT_REF, pathOfRef, readAuthorizedFile } from './files.js';
export { decodeText, novelsProvider, NOVELS_ROOT_REF, splitChapters, type Chapter } from './novels.js';
export { type ItemProvider, MAX_CONTENT_CHARS, type OpenContext, type SyncContext, textContent } from './provider.js';
export { createItemService, type ItemService, type ItemServiceOptions, SYNC_INTERVAL_MS } from './service.js';
export { sessionsProvider, SESSIONS_ROOT_REF } from './sessions.js';
export {
    chunkText,
    createKbTools,
    createKnowledgeBase,
    embedText,
    formatResults,
    guardCredentials,
    KB_EXTENSIONS,
    type KbVectors,
    type KnowledgeBase,
    type KnowledgeBaseOptions,
    MAX_CHUNKS_PER_FILE,
} from './kb/index.js';
export { createItemTools } from './tools.js';
export { MAX_DEPTH, MAX_ENTRIES_PER_ROOT, walk, type WalkEntry } from './walk.js';

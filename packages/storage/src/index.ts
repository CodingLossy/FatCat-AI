// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { join } from 'node:path';
import { openDatabase, type Connection } from './db.js';
import { migrate, type MigrateResult } from './migrate.js';
import { migrations } from './migrations/index.js';

export { AttachmentLinkError, type AttachmentRepository, type NewAttachment } from './attachments.js';
export type { AccessTokenRecord, AuthSessionRecord } from './auth.js';
export { encodeCursor, decodeCursor, InvalidCursorError, type Page } from './cursor.js';
export { applyPragmas, assertForeignKeysOn, openDatabase, StorageError, type Connection, type Sqlite } from './db.js';
export { newId } from './ids.js';
export { dedupKey, QUARANTINE_TTL_DAYS } from './memory.js';
export type {
    MemoryCandidate,
    MemoryExcerpt,
    MemoryReadRepository,
    OpenConflict,
    StoredDigest,
} from './memory-read.js';
export type { JobState, MaintenanceRow, MemoryMaintenanceRepository } from './memory-maintenance.js';
export type {
    ConflictResolution,
    ExtractRunCounts,
    ExtractRunJob,
    ExtractRunSummary,
    FeedbackSignal as StoredFeedbackSignal,
    MemoryConflict,
    MemorySourceRow,
    NewExtractRun,
    NewMemory,
    QuarantineEntry,
    QuarantineReason,
    SaveOutcome,
    SessionSummary,
} from './memory.js';
export type { ChannelPairingRecord, ChannelRecord, ChannelRepository } from './channels.js';
export type { ModelProfileRecord } from './profiles.js';
export type { NewApprovalRequest, NewAuditEntry } from './tools.js';
export {
    type EmbedCounts,
    type EmbedJob,
    type EmbedState,
    type EmbeddingStore,
    MAX_EMBED_ATTEMPTS,
    VECTOR_TABLE,
    type VectorMatch,
} from './embeddings.js';
export type { KbChunk, KbChunkInput, KbFile, KbRepository, KbSource } from './kb.js';
export { ItemCycleError, type ItemInput, type ItemRepository } from './items.js';
export {
    checksum,
    migrate,
    MigrationError,
    type Migration,
    type MigrateOptions,
    type MigrateResult,
} from './migrate.js';
export type { MailAccountCreate, MailAccountRecord, MailFolderSync, MailKnownFolder, MailMessageSync } from './mail.js';
export type { MailDraftCreate, MailItemRow, MailListQuery, MailMessageRecord } from './mail-cache.js';
export { migrations } from './migrations/index.js';
export { createRepositories, type AppendMessageInput, type PageRequest, type Repositories } from './repos.js';
export { TABLE_COLUMNS, type TableName } from './schema.js';

export interface OpenStorageOptions {
    /** 数据目录;数据库为 <dataDir>/db.sqlite,迁移前备份在 <dataDir>/backups/。 */
    dataDir: string;
    now?: () => Date;
}

/** 打开数据目录中的数据库并执行待执行的迁移;服务启动时调用。 */
export async function openStorage(options: OpenStorageOptions): Promise<{ conn: Connection; migrated: MigrateResult }> {
    const conn = openDatabase(join(options.dataDir, 'db.sqlite'));
    try {
        const migrated = await migrate(conn.sqlite, migrations, {
            backupDir: join(options.dataDir, 'backups'),
            ...(options.now ? { now: options.now } : {}),
        });
        return { conn, migrated };
    } catch (error) {
        conn.close();
        throw error;
    }
}

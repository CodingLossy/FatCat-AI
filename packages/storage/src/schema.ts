// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 各表的列清单与行类型。结构以 migrations/ 中的 SQL 为准,两者一致性由 repos.test.ts 校验。
// 不使用 ORM:drizzle-orm 0.45 仅加载就占用约 140 MB 堆内存,超出 2GB 机器的预算(ADR 0005)。

/** 表名 → 列名(snake_case,与 SQL 一致)。 */
export const TABLE_COLUMNS = {
    owners: ['id', 'username', 'password_hash', 'created_at', 'updated_at'],
    auth_sessions: ['id', 'owner_id', 'csrf_hash', 'created_at', 'expires_at', 'last_seen_at'],
    access_tokens: ['id', 'owner_id', 'name', 'token_hash', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'],
    model_profiles: [
        'id',
        'owner_id',
        'label',
        'kind',
        'base_url',
        'api_key_ref',
        'model',
        'purpose_json',
        'context_window',
        'params_json',
        'created_at',
        'updated_at',
    ],
    settings: ['owner_id', 'key', 'value_json', 'updated_at'],
    approval_requests: [
        'call_id',
        'owner_id',
        'run_id',
        'session_id',
        'tool_name',
        'risk',
        'summary',
        'input_json',
        'preauthorizable',
        'status',
        'created_at',
        'expires_at',
        'decided_at',
        'warnings_json',
    ],
    fs_roots: ['id', 'owner_id', 'path', 'label', 'created_at', 'kb_enabled'],
    mcp_servers: [
        'id',
        'owner_id',
        'name',
        'command',
        'args_json',
        'cwd',
        'env_names_json',
        'enabled',
        'tool_risks_json',
        'created_at',
        'updated_at',
    ],
    tool_preauth: [
        'id',
        'owner_id',
        'tool_name',
        'scope',
        'session_id',
        'constraint_json',
        'created_at',
        'last_used_at',
    ],
    audit_log: [
        'id',
        'owner_id',
        'at',
        'action',
        'tool_name',
        'risk',
        'call_id',
        'run_id',
        'session_id',
        'decision',
        'outcome',
        'summary',
        'input_digest',
        'error',
    ],
    sessions: [
        'id',
        'owner_id',
        'title',
        'model_profile_id',
        'forked_from_session_id',
        'forked_from_message_id',
        'last_message_at',
        'created_at',
        'updated_at',
        'untrusted_at',
    ],
    messages: [
        'id',
        'session_id',
        'owner_id',
        'seq',
        'role',
        'parts_json',
        'status',
        'run_id',
        'parent_message_id',
        'model_profile_id',
        'client_message_id',
        'usage_json',
        'created_at',
        'updated_at',
    ],
    runs: [
        'id',
        'session_id',
        'owner_id',
        'status',
        'input_message_id',
        'output_message_id',
        'error_json',
        'started_at',
        'finished_at',
    ],
    events: ['seq', 'owner_id', 'session_id', 'run_id', 'type', 'payload_json', 'created_at'],
    session_summaries: ['id', 'session_id', 'from_seq', 'to_seq', 'summary', 'created_at'],
    items: [
        'id',
        'owner_id',
        'kind',
        'type',
        'source',
        'source_ref',
        'title',
        'summary',
        'icon',
        'color',
        'child_count',
        'descendant_count',
        'meta',
        'created_at',
        'updated_at',
        'deleted_at',
    ],
    item_edges: ['parent_id', 'child_id', 'rel', 'position', 'primary_edge'],
    memory_facts: [
        'item_id',
        'owner_id',
        'mem_type',
        'subtype',
        'entity_key',
        'cardinality',
        'value_json',
        'status',
        'domain',
        'sensitivity',
        'confidence',
        'origin',
        'created_at',
        'updated_at',
        'supersedes_id',
        'decision_state',
        'tier',
        'importance',
        'decay_score',
        'pinned',
        'valid_from',
        'valid_to',
        'last_confirmed_at',
        'last_accessed_at',
        'access_count',
        'helpful_count',
        'stale_count',
        'wrong_count',
    ],
    memory_conflicts: ['id', 'owner_id', 'a_id', 'b_id', 'kind', 'status', 'created_at', 'resolved_at'],
    memory_feedback: ['id', 'memory_id', 'signal', 'note', 'run_id', 'channel', 'created_at'],
    memory_quarantine: ['id', 'owner_id', 'session_id', 'raw_json', 'reason', 'created_at', 'expires_at'],
    memory_digest: ['owner_id', 'body', 'token_estimate', 'memory_ids', 'built_at'],
    jobs_state: ['owner_id', 'job', 'last_run_at', 'next_run_at', 'state_json'],
    memory_sources: [
        'id',
        'memory_id',
        'session_id',
        'user_message_id',
        'answer_message_id',
        'source_item_id',
        'excerpt',
        'created_at',
        'extract_run_id',
    ],
    memory_extract_runs: [
        'id',
        'owner_id',
        'job',
        'session_id',
        'user_message_id',
        'profile_id',
        'model',
        'prompt_version',
        'status',
        'written',
        'quarantined',
        'refused',
        'error_code',
        'created_at',
    ],
    embed_queue: [
        'id',
        'owner_id',
        'item_id',
        'chunk',
        'text',
        'attempts',
        'next_attempt_at',
        'last_error',
        'created_at',
    ],
    embeddings: ['id', 'owner_id', 'item_id', 'chunk', 'text', 'model', 'created_at'],
    embed_state: ['id', 'profile_id', 'model', 'dimensions', 'created_at'],
    embed_usage: ['owner_id', 'day', 'count'],
    kb_sources: ['item_id', 'owner_id', 'mtime', 'size', 'chunk_chars', 'chunks', 'error', 'indexed_at'],
    kb_chunks: ['id', 'owner_id', 'item_id', 'chunk', 'page', 'heading', 'text'],
    mail_accounts: [
        'id',
        'owner_id',
        'label',
        'address',
        'username',
        'password_ref',
        'imap_json',
        'smtp_json',
        'initial_sync_days',
        'sync_interval_minutes',
        'append_to_sent',
        'enabled',
        'last_synced_at',
        'last_error',
        'failures',
        'next_sync_at',
        'created_at',
        'updated_at',
        'sent_copy',
    ],
    mail_folders: [
        'id',
        'account_id',
        'path',
        'name',
        'special_use',
        'uid_validity',
        'last_uid',
        'highest_modseq',
        'last_synced_at',
    ],
    mail_messages: [
        'seq',
        'id',
        'account_id',
        'message_id',
        'in_reply_to',
        'references_json',
        'thread_key',
        'from_json',
        'reply_to_json',
        'to_json',
        'cc_json',
        'subject',
        'date',
        'unread',
        'body',
        'snippet',
        'created_at',
    ],
    mail_message_folders: ['folder_id', 'uid', 'message_id'],
    mail_attachments: ['id', 'message_id', 'part', 'filename', 'content_type', 'size', 'downloaded'],
    mail_drafts: [
        'id',
        'account_id',
        'to_json',
        'cc_json',
        'subject',
        'body',
        'reply_to_message_id',
        'attachments_json',
        'created_at',
        'updated_at',
    ],
} as const satisfies Record<string, readonly string[]>;

export type TableName = keyof typeof TABLE_COLUMNS;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** 生成 `col AS "camelCol", …` 的 SELECT 列表;prefix 用于联表时限定表名。 */
export function selectList(table: TableName, prefix = table): string {
    return TABLE_COLUMNS[table].map((c) => `${prefix}.${c} AS "${camel(c)}"`).join(', ');
}

export interface OwnerRow {
    id: string;
    username: string;
    passwordHash: string;
    createdAt: string;
    updatedAt: string;
}

export interface SessionRow {
    id: string;
    ownerId: string;
    title: string;
    modelProfileId: string | null;
    forkedFromSessionId: string | null;
    forkedFromMessageId: string | null;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
    untrustedAt: string | null;
}

export interface MessageRow {
    id: string;
    sessionId: string;
    ownerId: string;
    seq: number;
    role: 'user' | 'assistant' | 'system';
    partsJson: string;
    status: 'streaming' | 'complete' | 'error' | 'cancelled';
    runId: string | null;
    parentMessageId: string | null;
    modelProfileId: string | null;
    clientMessageId: string | null;
    usageJson: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface RunRow {
    id: string;
    sessionId: string;
    ownerId: string;
    status: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';
    inputMessageId: string;
    outputMessageId: string | null;
    errorJson: string | null;
    startedAt: string;
    finishedAt: string | null;
}

export interface EventRow {
    seq: number;
    ownerId: string;
    sessionId: string | null;
    runId: string | null;
    type: string;
    payloadJson: string;
    createdAt: string;
}

export interface AuthSessionRow {
    id: string;
    ownerId: string;
    csrfHash: string;
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string;
}

export interface AccessTokenRow {
    id: string;
    ownerId: string;
    name: string;
    tokenHash: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
}

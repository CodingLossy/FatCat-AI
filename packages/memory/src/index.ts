// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

export {
    CREDENTIAL_PLACEHOLDER,
    type CredentialKind,
    detectCredential,
    detectCredentialIn,
    redactCredentials,
} from './secrets.js';
export { type Redaction, redactSensitive, redactSensitiveIn, type SensitiveKind } from './sensitive.js';
export { type EntityKeySpec, isProfileKey, normalizeEntityKey, type NormalizedKey } from './entity-keys.js';
export {
    type Complete,
    createExtractor,
    EXTRACT_JOB,
    type Extractor,
    type ExtractOutcome,
    MAX_ITEMS_PER_TURN,
    type TurnInfo,
} from './extract.js';
export { looksLikeInstruction } from './instructions.js';
export { createMemoryContext, type MemoryContext, type MemoryContextInput } from './context.js';
export { createDigestBuilder, DIGEST_DEBOUNCE_MS, DIGEST_MAX_ITEMS, type DigestBuilder } from './digest.js';
export {
    BLOCK_HEADER,
    classifyVectorError,
    createRetriever,
    type DegradationDetail,
    qualify,
    renderMemory,
    rerank,
    type RetrieveOptions,
    type Retriever,
    type VectorSearch,
} from './retrieve.js';
export {
    createMaintenanceRunner,
    decayScore,
    HALF_LIFE_DAYS,
    type JobOutcome,
    MAINTENANCE_JOBS,
    type MaintenanceJob,
    type MaintenanceRunner,
    nextTier,
} from './maintenance.js';
export { estimateTokens } from './tokens.js';
export {
    createMemoryService,
    defaultCardinality,
    type MemoryService,
    type MemoryServiceHooks,
    type WriteContext,
} from './service.js';

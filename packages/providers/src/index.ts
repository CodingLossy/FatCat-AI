// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

export {
    ANTHROPIC_BASE_URL,
    ANTHROPIC_VERSION,
    createAnthropicProvider,
    toAnthropicMessages,
    type NativeProviderOptions,
} from './anthropic.js';
export { createGeminiProvider, GEMINI_BASE_URL, toGeminiContents, toGeminiSchema } from './gemini.js';
export {
    classifyStatus,
    createOpenAICompatibleProvider,
    toWireToolName,
    type OpenAICompatibleOptions,
} from './openai-compatible.js';
export { REDACTED, Redactor, sanitizeUpstreamText } from './redact.js';
export { createProvider, selectProfile, type ProviderDeps } from './registry.js';
export {
    parseSecretsFile,
    SECRETS_FILE,
    SECRETS_BACKUP_DIR,
    SecretsWriteError,
    writeSecretsKey,
    SecretsFileError,
    SecretsLayoutError,
    SECRETS_ENC_FILE,
    SECRETS_MIGRATED_FILE,
    restrictToCurrentUser,
    secretsLayout,
    SecretStore,
    type KeyStatusValue,
    type SecretStoreOptions,
} from './secrets.js';
export {
    createMasterKeyResolver,
    decryptSecrets,
    encodeMasterKey,
    encryptSecrets,
    generateMasterKey,
    keyFingerprint,
    MasterKeyFormatError,
    parseMasterKey,
    SecretsEnvelopeError,
    SecretsKeyUnavailableError,
    type MasterKeyResolution,
    type MasterKeyResolver,
} from './secrets-crypto.js';
export {
    cleanupMigrated,
    migrateSecrets,
    readSecretsStatus,
    rekeySecrets,
    SecretsMigrateError,
} from './secrets-migrate.js';
export {
    createVoiceClient,
    DEFAULT_TTS_VOICE,
    type SpeakRequest,
    type TranscribeRequest,
    type VoiceClient,
    type VoiceClientOptions,
} from './voice.js';
export {
    type ChatChunk,
    type ChatMessage,
    type ChatRequest,
    type ContentPart,
    contentParts,
    hasImage,
    type ImageMediaType,
    plainText,
    type EmbedResult,
    type FinishReason,
    MAX_EMBED_BATCH,
    type ModelProvider,
    ProviderError,
    type ProviderProfile,
    type ToolCall,
    type ToolSpec,
} from './types.js';

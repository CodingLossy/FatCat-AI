// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具框架(ADR 0010):工具定义、注册表、审批策略、审计摘要,以及内置工具。
export {
    composeUntrustedBlocks,
    stripUntrustedBlocks,
    UNTRUSTED_INTRO,
    untrustedBlockLine,
    type UntrustedKind,
} from './untrusted-blocks.js';
export { DIGEST_LIMIT, inputDigest, redactedInput } from './digest.js';
export {
    checkRemember,
    prepareRemember,
    decide,
    defaultApproval,
    isEnabled,
    isPreauthorizable,
    type PolicyDecision,
    type PolicyOptions,
} from './policy.js';
export { ToolRegistry, type ToolSpecLike } from './registry.js';
export { type ToolContext, type ToolDefinition, ToolDeniedError } from './types.js';
export { type BuiltinToolOptions, createBuiltinTools } from './builtin/index.js';
export { CalcError, createCalcTool, evaluate } from './builtin/calc.js';
export { htmlToText } from './builtin/html.js';
export { isBlockedAddress } from './builtin/net-guard.js';
export { createTimeTool } from './builtin/time.js';
export {
    checkUrl,
    createWebFetchTool,
    fetchHost,
    guardedFetch,
    MAX_BODY_BYTES,
    MAX_REDIRECTS,
    MAX_TEXT_CHARS,
    WebFetchError,
    type WebFetchOptions,
} from './builtin/web-fetch.js';
export {
    caseInsensitive,
    checkLexical,
    checkWritableTarget,
    isFilesystemRoot,
    isWithin,
    normalizeRoot,
    PathError,
    resolveInRoots,
} from './fs/paths.js';
export { createFsTools, type FsToolOptions, MAX_DOCUMENT_CHARS, MAX_READ_BYTES, MAX_WRITE_BYTES } from './fs/tools.js';
export {
    documentKind,
    type DocumentKind,
    type ExtractedDocument,
    extractDocument,
    extractDocx,
    extractPdf,
    extractXlsx,
} from './docs/extract.js';
export { MAX_DOCUMENT_BYTES, parseInWorker } from './docs/parse.js';
export { DocumentError, ZipReader } from './docs/zip.js';

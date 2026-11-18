// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件市场的独立入口(@fatcat-ai/tools/market):验签、下载、tar 解包与包检查。不含插件运行时,
// 所以浏览市场不会加载运行时代码(ADR 0040 第 8 节)。
export {
    downloadPackage,
    fetchIndexFiles,
    fetchLimited,
    INDEX_MAX_BYTES,
    MarketError,
    type MarketConfig,
    type MarketErrorCode,
    type MarketKey,
    OFFICIAL_INDEX_URL,
    OFFICIAL_MARKET_ID,
    OFFICIAL_MARKET_KEYS,
    officialMarket,
    publicKeyFromRaw,
    verifyIndex,
    type VerifiedIndex,
} from './market.js';
export { extractTgz, MAX_COMPRESSION_RATIO, TAR_LIMITS, type TarLimits } from './tar.js';
export { hashPluginDir, PACKAGE_LIMITS, PluginPackageError, validateStagedPackage } from './package.js';

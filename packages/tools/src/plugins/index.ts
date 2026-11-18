// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件运行时的独立入口(@fatcat-ai/tools/plugins):只在安装了插件时才动态导入(ADR 0040 第 8 节)。
export { findReparsePoint, pluginEnv, pluginNodeArgs, preloadScriptPath } from './launch.js';
export {
    badPackagePath,
    hashPluginDir,
    PACKAGE_LIMITS,
    PluginPackageError,
    type PreparedPackage,
    prepareLocalPackage,
    scanPackageDir,
} from './package.js';
export {
    effectiveRisk,
    PluginRuntime,
    type PluginEventInput,
    type PluginRunState,
    type PluginRuntimeOptions,
    type PluginRuntimeRecord,
    type PluginRuntimeSettings,
    type PluginRuntimeStatus,
    redactSecrets,
    RUNTIME_SETTINGS_KEY,
} from './runtime.js';

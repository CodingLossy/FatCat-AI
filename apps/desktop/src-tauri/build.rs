// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/// 内置浏览器面板的命令(ADR 0046 第 3.4 节):只有 `capabilities/main.json` 里列出的 webview(主界面)能调用。
const BROWSER_COMMANDS: &[&str] = &[
    "browser_open",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_set_bounds",
    "browser_set_visible",
    "browser_close",
    "browser_screenshot",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(BROWSER_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! `system.open` 的执行端(ADR 0046 第 5 节):核心校验、用户逐次批准之后,主界面把目标交给这里。
//! 只有主窗口里、来源是本应用核心的页面能调用(与浏览器命令同一道检查),目标按 `open_policy` 再检查一次,
//! 然后交给系统的「用默认程序打开」:一个固定的程序加一个参数,不经 shell,没有其他参数、工作目录或环境变量。

use serde::Deserialize;
use std::ffi::OsString;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Webview};

use crate::browser::ensure_app_caller;
use crate::open_policy;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OpenTarget {
    Url { url: String },
    File { path: String },
}

/// 各平台「用默认程序打开」的固定程序。
fn opener() -> &'static str {
    if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    }
}

#[tauri::command]
pub fn system_open(app: AppHandle, webview: Webview, target: OpenTarget) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    let arg: OsString = match target {
        OpenTarget::Url { url } => open_policy::check_url(&url).map_err(|d| d.code().to_string())?.into(),
        OpenTarget::File { path } => open_policy::check_file(&path)
            .map_err(|d| d.code().to_string())?
            .into_os_string(),
    };
    Command::new(opener())
        .arg(arg)
        .env_clear()
        .envs(std::env::vars_os().filter(|(k, _)| {
            // 只保留找到桌面会话所需的变量,不把应用自己的环境(核心端口、令牌等)传下去
            matches!(
                k.to_str().unwrap_or(""),
                "PATH"
                    | "HOME"
                    | "USERPROFILE"
                    | "SystemRoot"
                    | "DISPLAY"
                    | "WAYLAND_DISPLAY"
                    | "XDG_RUNTIME_DIR"
                    | "DBUS_SESSION_BUS_ADDRESS"
                    | "LANG"
            )
        }))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "failed".to_string())
}

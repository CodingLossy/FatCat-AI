// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! `system.open` 在壳这一侧的第二道检查(ADR 0046 第 5.2 节)。纯逻辑,不依赖 Tauri,可以单独测试。
//!
//! 核心已经校验过目标并经用户批准;壳不信任这一点,再按同一份规则检查一次:网址只允许 https / http / mailto、
//! 不带凭据;文件必须是存在的绝对路径、是普通文件、不是程序或脚本(按扩展名,POSIX 上再看可执行位,
//! macOS 的 `.app` 包是目录所以本来就会被拒)。授权目录只有核心知道,由核心检查。

use std::path::{Path, PathBuf};
use url::Url;

/// 拒绝的扩展名,与核心 `BLOCKED_EXTENSIONS` 相同(全部小写、不带点)。
pub const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "scr", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
    "cpl", "jar", "lnk", "url", "reg", "dll", "sys", "app", "command", "sh", "bash", "zsh", "run", "appimage",
    "desktop", "dmg", "pkg", "deb", "rpm", "iso",
];

/// 拒绝原因的稳定码(界面和核心都只看这个)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenDenied {
    /// 协议、凭据、类型或可执行位不允许。
    Blocked,
    /// 文件不存在或不是普通文件。
    NotFound,
}

impl OpenDenied {
    pub fn code(self) -> &'static str {
        match self {
            OpenDenied::Blocked => "blocked",
            OpenDenied::NotFound => "not_found",
        }
    }
}

/// 检查网址,返回规范化后的网址文本。
pub fn check_url(raw: &str) -> Result<String, OpenDenied> {
    let url = Url::parse(raw).map_err(|_| OpenDenied::Blocked)?;
    match url.scheme() {
        "https" | "http" => {
            if url.host_str().unwrap_or("").is_empty() {
                return Err(OpenDenied::Blocked);
            }
        }
        "mailto" => {}
        _ => return Err(OpenDenied::Blocked),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(OpenDenied::Blocked);
    }
    Ok(url.to_string())
}

/// 文件名最后一个扩展名是否在拒绝清单里(`a.pdf.exe` 按 exe 拒绝)。
pub fn blocked_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| BLOCKED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// 检查文件,返回解析符号链接之后的真实路径。
pub fn check_file(raw: &str) -> Result<PathBuf, OpenDenied> {
    let path = Path::new(raw);
    if !path.is_absolute() || blocked_extension(path) {
        return Err(OpenDenied::Blocked);
    }
    let real = dunce::canonicalize(path).map_err(|_| OpenDenied::NotFound)?;
    if blocked_extension(&real) {
        return Err(OpenDenied::Blocked);
    }
    let meta = std::fs::metadata(&real).map_err(|_| OpenDenied::NotFound)?;
    if !meta.is_file() {
        // 目录(含 macOS 的 .app 包)一律不打开
        return Err(OpenDenied::Blocked);
    }
    if executable(&meta) {
        return Err(OpenDenied::Blocked);
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(check_url("https://example.com/a?b=1").is_ok());
        assert!(check_url("http://example.com/").is_ok());
        assert!(check_url("mailto:someone@example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "vscode://file/x",
            "steam://run/1",
            "search-ms:query=x",
            "https://user:pass@example.com/",
            "not a url",
        ] {
            assert_eq!(check_url(bad), Err(OpenDenied::Blocked), "{bad}");
        }
    }

    #[test]
    fn extensions() {
        for bad in [
            "a.exe",
            "A.EXE",
            "report.pdf.exe",
            "x.ps1",
            "x.AppImage",
            "x.app",
            "x.lnk",
            "x.sh",
        ] {
            assert!(blocked_extension(Path::new(bad)), "{bad}");
        }
        for ok in ["a.pdf", "notes.txt", "Makefile", "photo.JPG"] {
            assert!(!blocked_extension(Path::new(ok)), "{ok}");
        }
    }

    #[test]
    fn files() {
        let dir = std::env::temp_dir().join(format!("fatcat-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("folder.app")).unwrap();
        std::fs::write(dir.join("notes.pdf"), b"x").unwrap();
        std::fs::write(dir.join("setup.exe"), b"x").unwrap();
        let notes = dir.join("notes.pdf");
        assert_eq!(
            check_file(notes.to_str().unwrap()),
            Ok(dunce::canonicalize(&notes).unwrap())
        );
        assert_eq!(check_file("notes.pdf"), Err(OpenDenied::Blocked));
        assert_eq!(
            check_file(dir.join("setup.exe").to_str().unwrap()),
            Err(OpenDenied::Blocked)
        );
        assert_eq!(
            check_file(dir.join("missing.pdf").to_str().unwrap()),
            Err(OpenDenied::NotFound)
        );
        assert_eq!(
            check_file(dir.join("folder.app").to_str().unwrap()),
            Err(OpenDenied::Blocked)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            std::fs::write(dir.join("run-me"), b"#!/bin/sh").unwrap();
            std::fs::set_permissions(dir.join("run-me"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                check_file(dir.join("run-me").to_str().unwrap()),
                Err(OpenDenied::Blocked)
            );
            let _ = std::fs::remove_file(dir.join("innocent.pdf"));
            symlink(dir.join("setup.exe"), dir.join("innocent.pdf")).unwrap();
            assert_eq!(
                check_file(dir.join("innocent.pdf").to_str().unwrap()),
                Err(OpenDenied::Blocked)
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

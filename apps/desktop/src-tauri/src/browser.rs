// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! 内置浏览器面板(ADR 0046 第 3 节,M12 PR 7):主窗口里的一个子 webview。
//!
//! 边界(都在 ADR 里有对应条款):
//! - 子 webview 的标签是 `browser`,没有任何 Tauri 能力(`capabilities/main.json` 只给 `main` webview),
//!   不注入脚本、不启用 `withGlobalTauri`,页面拿不到 IPC;
//! - 数据存储独立且是临时的:`incognito` + 每次新建的数据目录,面板关闭时整目录删除,启动时清掉上次崩溃留下的;
//! - 顶层导航经 `browser_policy`(仅 https、无凭据、无 IP、无内部名);下载取消,新窗口拒绝;
//! - 命令只接受主窗口里本应用界面(核心的回环来源)发来的调用;
//! - 日志只写来源(`scheme://host[:port]`),不写路径、查询串、片段。
//!
//! 已知缺口(ADR 0046 第 14 节):没有回环过滤代理,所以页面的子资源请求和 DNS 解析结果不受白名单约束;
//! 权限请求(摄像头、麦克风、定位等)只在 Windows 上由壳直接拒绝,macOS 上仍由系统弹窗询问用户。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};
use url::Url;

use crate::browser_policy::{self, Denied};
use crate::SidecarState;

/// 子 webview 的标签;能力文件里没有这个标签。
pub const BROWSER_LABEL: &str = "browser";
/// 面板的数据目录都放在这个子目录下。
const PROFILE_ROOT: &str = "browser-profile";

/// 当前面板的状态。同一时间最多一个面板。
#[derive(Default)]
pub struct BrowserState(Mutex<Option<Session>>);

struct Session {
    profile_dir: PathBuf,
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn profile_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(PROFILE_ROOT))
        .map_err(|e| e.to_string())
}

/// 应用启动时调用:清掉上一次崩溃或强杀后留下的浏览器数据目录。
pub fn clear_stale_profiles(app: &AppHandle) {
    if let Ok(root) = profile_root(app) {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// 删除一个数据目录;Windows 上 webview 进程可能还握着文件,多试几次。
fn remove_profile(dir: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..10 {
            if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    });
}

/// 只有主窗口里、来源是本应用核心的页面才能调用浏览器命令(能力文件之外的第二道检查)。
fn ensure_app_caller(app: &AppHandle, caller: &Webview) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("not allowed".into());
    }
    let port = app
        .try_state::<SidecarState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|sc| sc.as_ref().map(|sc| sc.port))
        })
        .ok_or("the core service is not running")?;
    let url = caller.url().map_err(|e| e.to_string())?;
    if browser_policy::is_app_origin(&url, port) {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

/// 把面板状态通知给主窗口的界面(页面里 `window.addEventListener('fatcat-browser', …)` 接收)。
/// 载荷由 serde_json 序列化,地址里的引号和 `</script>` 之类都不会破坏脚本。
fn notify(app: &AppHandle, payload: serde_json::Value) {
    if let Some(main) = app.get_webview_window("main") {
        let script =
            format!("window.dispatchEvent(new CustomEvent('fatcat-browser',{{detail:{payload}}}))");
        let _ = main.eval(script);
    }
}

fn denied_message(reason: Denied) -> String {
    reason.code().to_string()
}

fn build_webview(app: &AppHandle, url: Url, profile_dir: &Path) -> WebviewBuilder<tauri::Wry> {
    let nav_app = app.clone();
    let load_app = app.clone();
    let popup_app = app.clone();
    let download_app = app.clone();
    let builder = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(url))
        .incognito(true)
        .data_directory(profile_dir.to_path_buf())
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |target| match browser_policy::check_navigation(target) {
            Ok(()) => {
                notify(&nav_app, json!({"type": "navigating", "url": target.as_str()}));
                true
            }
            Err(reason) => {
                // 日志只记来源;界面收到的是被拒绝的原因和来源,不含路径与查询串
                eprintln!("browser: navigation to {} blocked ({})", browser_policy::origin_for_log(target), reason.code());
                notify(
                    &nav_app,
                    json!({"type": "blocked", "what": "navigation", "reason": reason.code(),
                           "origin": browser_policy::origin_for_log(target)}),
                );
                false
            }
        })
        .on_page_load(move |webview, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            notify(
                &load_app,
                json!({"type": if finished { "loaded" } else { "loading" }, "url": payload.url().as_str(),
                       "label": webview.label()}),
            );
        })
        .on_new_window(move |target, _features| {
            notify(
                &popup_app,
                json!({"type": "blocked", "what": "popup", "origin": browser_policy::origin_for_log(&target)}),
            );
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            if let tauri::webview::DownloadEvent::Requested { url, .. } = &event {
                notify(
                    &download_app,
                    json!({"type": "blocked", "what": "download", "origin": browser_policy::origin_for_log(url)}),
                );
            }
            // 下载一律取消;打开下载的文件属于 system.open,需要审批
            false
        });
    builder
}

fn unique_profile_dir(root: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    root.join(format!("{}-{nanos}", std::process::id()))
}

/// 打开面板并加载地址。已经打开时改为导航并调整位置。
#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    url: String,
    bounds: Bounds,
) -> Result<String, String> {
    ensure_app_caller(&app, &webview)?;
    let target = browser_policy::normalize_address(&url).map_err(denied_message)?;
    if let Some(existing) = app.get_webview(BROWSER_LABEL) {
        existing
            .navigate(target.clone())
            .map_err(|e| e.to_string())?;
        set_bounds(&existing, bounds)?;
        return Ok(target.to_string());
    }
    let root = profile_root(&app)?;
    let profile_dir = unique_profile_dir(&root);
    std::fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
    let window = app.get_window("main").ok_or("the main window is gone")?;
    let builder = build_webview(&app, target.clone(), &profile_dir);
    let child = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| {
            remove_profile(profile_dir.clone());
            e.to_string()
        })?;
    #[cfg(windows)]
    crate::browser_windows::harden(&child);
    #[cfg(not(windows))]
    let _ = &child;
    *state.0.lock().map_err(|e| e.to_string())? = Some(Session { profile_dir });
    Ok(target.to_string())
}

fn set_bounds(webview: &Webview, bounds: Bounds) -> Result<(), String> {
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|e| e.to_string())
}

fn browser_webview(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview(BROWSER_LABEL)
        .ok_or_else(|| "the browser panel is not open".to_string())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, webview: Webview, url: String) -> Result<String, String> {
    ensure_app_caller(&app, &webview)?;
    let target = browser_policy::normalize_address(&url).map_err(denied_message)?;
    browser_webview(&app)?
        .navigate(target.clone())
        .map_err(|e| e.to_string())?;
    Ok(target.to_string())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, webview: Webview) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    browser_webview(&app)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, webview: Webview) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    browser_webview(&app)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, webview: Webview) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    browser_webview(&app)?.reload().map_err(|e| e.to_string())
}

/// 界面里占位元素的位置或大小变了(窗口缩放、面板拖动)。
#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, webview: Webview, bounds: Bounds) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    set_bounds(&browser_webview(&app)?, bounds)
}

/// 命令面板、审批条等浮层出现时先把原生 webview 藏起来(原生视图总是盖在网页内容之上)。
#[tauri::command]
pub fn browser_set_visible(app: AppHandle, webview: Webview, visible: bool) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    let panel = browser_webview(&app)?;
    if visible { panel.show() } else { panel.hide() }.map_err(|e| e.to_string())
}

/// 关闭面板并丢弃它的 cookie、存储和缓存(删除整个数据目录)。
#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    ensure_app_caller(&app, &webview)?;
    close_session(&app, &state);
    Ok(())
}

/// 退出应用时也要清理。
pub fn close_session(app: &AppHandle, state: &BrowserState) {
    if let Some(panel) = app.get_webview(BROWSER_LABEL) {
        let _ = panel.close();
    }
    if let Some(session) = state.0.lock().ok().and_then(|mut s| s.take()) {
        remove_profile(session.profile_dir);
    }
}

/// 截图的最大字节数(与核心的 CLIENT_CALL_IMAGE_MAX_BYTES 一致:整个请求体受 2 MiB 上限约束)。
const SCREENSHOT_MAX_BYTES: usize = 1_500_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    mime_type: &'static str,
    width: u32,
    height: u32,
    /// base64,不含 data: 前缀。
    data: String,
}

/// 截取面板当前显示的页面。目前只有 Windows(WebView2 的 CapturePreview)实现了;其他平台返回
/// `unsupported`,核心会把它当作 browser_unavailable 告诉模型,不会悄悄改用别的方式(ADR 0046 第 3.1 节)。
#[tauri::command]
pub async fn browser_screenshot(app: AppHandle, webview: Webview) -> Result<Screenshot, String> {
    ensure_app_caller(&app, &webview)?;
    #[cfg(windows)]
    {
        use base64::Engine as _;
        let panel = browser_webview(&app)?;
        let (tx, rx) = std::sync::mpsc::channel();
        crate::browser_windows::capture(&panel, tx);
        // 完成回调在主线程上触发,这里只能在别的线程上等
        let shot = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(10))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "timeout".to_string())?
        .map_err(|code| code.to_string())?;
        if shot.jpeg.len() > SCREENSHOT_MAX_BYTES {
            return Err("too_large".into());
        }
        Ok(Screenshot {
            mime_type: "image/jpeg",
            width: shot.width,
            height: shot.height,
            data: base64::engine::general_purpose::STANDARD.encode(&shot.jpeg),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, SCREENSHOT_MAX_BYTES);
        Err("unsupported".into())
    }
}

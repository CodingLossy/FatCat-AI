// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! FatCat-AI 桌面壳:启动核心 sidecar(随机回环端口),等它就绪后在窗口里加载;
//! 关窗只隐藏到托盘,托盘菜单「退出」才真正退出。壳退出(含崩溃)时 sidecar 因 stdin 管道关闭而自行退出。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod browser_policy;
#[cfg(windows)]
mod browser_windows;
mod deeplink;
mod open_policy;
mod sidecar;
mod system_open;

use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 唤起主窗口并让输入框获得焦点(全局快捷键用)。
fn quick_ask(app: &AppHandle) {
    show_main(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("document.querySelector('.composer textarea')?.focus()");
    }
}

/// 处理深链接:只翻译白名单动作为窗口内相对地址,其余忽略。
fn open_deep_link(app: &AppHandle, raw: &str) {
    let Some(path) = deeplink::to_app_path(raw) else { return };
    let Some(state) = app.try_state::<SidecarState>() else { return };
    let port = match state.0.lock().unwrap().as_ref() {
        Some(sc) => sc.port,
        None => return,
    };
    show_main(app);
    if let (Some(window), Ok(url)) =
        (app.get_webview_window("main"), format!("http://127.0.0.1:{port}{path}").parse())
    {
        let _ = window.navigate(url);
    }
}

struct SidecarState(Mutex<Option<sidecar::Sidecar>>);

/// 托盘与对话框文案(M12:中文为默认,英文用户保留英文)。
struct Texts {
    show: &'static str,
    autostart: &'static str,
    quit: &'static str,
    start_failed: &'static str,
}

const TEXTS_ZH: Texts =
    Texts { show: "打开 FatCat-AI", autostart: "开机自启", quit: "退出", start_failed: "FatCat-AI 无法启动核心服务。" };
const TEXTS_EN: Texts =
    Texts { show: "Show FatCat-AI", autostart: "Start at login", quit: "Quit", start_failed: "FatCat-AI could not start its core service." };

/// 按系统语言选文案:语言代码以 en 开头、或为 C / POSIX 时用英文,其余(含取不到时)用中文。
fn texts_for(locale: &str) -> &'static Texts {
    let l = locale.trim().to_ascii_lowercase();
    if l.starts_with("en") || l == "c" || l == "posix" {
        &TEXTS_EN
    } else {
        &TEXTS_ZH
    }
}

/// 从环境变量读系统语言(Linux / macOS 的终端启动);Windows 与图形界面启动时通常没有,取不到就走默认的中文。
fn system_locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::texts_for;

    #[test]
    fn picks_chinese_by_default_and_english_for_en_locales() {
        assert_eq!(texts_for("").quit, "退出");
        assert_eq!(texts_for("zh_CN.UTF-8").quit, "退出");
        assert_eq!(texts_for("en_US.UTF-8").quit, "Quit");
        assert_eq!(texts_for("C").quit, "Quit");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let quick_ask_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let app = tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_screenshot,
            system_open::system_open,
        ])
        // 第二次启动(含 Windows / Linux 上点深链接)只把参数交给已运行的实例。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main(app);
            for arg in args.iter().skip(1) {
                open_deep_link(app, arg);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &quick_ask_shortcut && event.state() == ShortcutState::Pressed {
                        quick_ask(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let text = texts_for(&system_locale());
            // 内置浏览器的数据目录是临时的:上次崩溃或被强杀留下的先清掉(ADR 0046 第 3.2 节)
            browser::clear_stale_profiles(app.handle());
            let data_dir = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir().ok();
            let sc = match sidecar::Sidecar::start(&data_dir, resource_dir.as_deref()) {
                Ok(sc) => sc,
                Err(err) => {
                    // 窗口模式下没有控制台,失败时必须让用户看到原因和日志位置,而不是静默退出。
                    app.dialog()
                        .message(format!("{}\n\n{err}", text.start_failed))
                        .title("FatCat-AI")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    return Err(err);
                }
            };
            let url = format!("http://127.0.0.1:{}/", sc.port);
            app.manage(SidecarState(Mutex::new(Some(sc))));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("FatCat-AI")
                .inner_size(1100.0, 760.0)
                .build()?;

            let show = MenuItem::with_id(app, "show", text.show, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", text.quit, true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(app, "autostart", text.autostart, true, autostart_enabled, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &autostart, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("FatCat-AI")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "autostart" => {
                        let launch = app.autolaunch();
                        let _ = if launch.is_enabled().unwrap_or(false) { launch.disable() } else { launch.enable() };
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } =
                        event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // 快捷键被别的程序占用时注册会失败:不影响其余功能。
            let _ = app.global_shortcut().register(quick_ask_shortcut);
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_deep_link(&handle, url.as_str());
                }
            });
            // Windows / Linux 开发期没有安装器登记协议,运行时补登记。
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗只隐藏,进程和 sidecar 继续运行(托盘驻留)。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop shell");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(browser) = app.try_state::<browser::BrowserState>() {
                browser::close_session(app, &browser);
            }
            if let Some(state) = app.try_state::<SidecarState>() {
                if let Some(sc) = state.0.lock().unwrap().take() {
                    sc.stop();
                }
            }
        }
    });
}

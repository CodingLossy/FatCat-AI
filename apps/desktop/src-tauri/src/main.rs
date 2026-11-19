// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! FatCat-AI 桌面壳:启动核心 sidecar(随机回环端口),等它就绪后在窗口里加载;
//! 关窗只隐藏到托盘,托盘菜单「退出」才真正退出。壳退出(含崩溃)时 sidecar 因 stdin 管道关闭而自行退出。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deeplink;
mod sidecar;

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
            let data_dir = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir().ok();
            let sc = match sidecar::Sidecar::start(&data_dir, resource_dir.as_deref()) {
                Ok(sc) => sc,
                Err(err) => {
                    // 窗口模式下没有控制台,失败时必须让用户看到原因和日志位置,而不是静默退出。
                    app.dialog()
                        .message(format!("FatCat-AI could not start its core service.\n\n{err}"))
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

            let show = MenuItem::with_id(app, "show", "Show FatCat-AI", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_enabled, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &autostart, &quit])?;
            let mut tray = TrayIconBuilder::new()
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
            if let Some(state) = app.try_state::<SidecarState>() {
                if let Some(sc) = state.0.lock().unwrap().take() {
                    sc.stop();
                }
            }
        }
    });
}

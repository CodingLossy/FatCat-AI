// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! Windows(WebView2)上的浏览器面板加固与截图(ADR 0046 第 3.5 节、第 14 节)。
//! 在 Linux 容器里只能做类型检查(`cargo check --target x86_64-pc-windows-msvc`),行为需要在 Windows 上实测。

use std::sync::mpsc::Sender;

use tauri::Webview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
    COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::{CapturePreviewCompletedHandler, PermissionRequestedEventHandler};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHCreateMemStream;

/// 一张截图。
pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 关掉页面不该有的能力:所有权限请求直接拒绝,不弹窗;页面的 alert / confirm / prompt 不弹系统对话框;
/// 不要状态栏、密码保存和自动填充;发布版没有开发者工具。
pub fn harden(webview: &Webview) {
    let _ = webview.with_webview(|platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let mut token = 0i64;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        }));
        let _ = core.add_PermissionRequested(&handler, &mut token);
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
            let _ = settings.SetIsStatusBarEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(cfg!(debug_assertions));
        }
        // 密码保存与自动填充在较新的接口上;取不到(旧运行时)就算了
        use windows::core::Interface;
        if let Ok(settings) = core.Settings() {
            if let Ok(s4) = settings
                .cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4>(
            ) {
                let _ = s4.SetIsPasswordAutosaveEnabled(false);
                let _ = s4.SetIsGeneralAutofillEnabled(false);
            }
        }
    });
}

/// 截取页面当前画面(JPEG)。结果通过 `tx` 回到调用方;出错时发回错误码字符串。
/// 在主线程上发起,完成回调也在主线程,调用方不能在主线程上阻塞等待。
pub fn capture(webview: &Webview, tx: Sender<Result<Shot, &'static str>>) {
    let failed = tx.clone();
    let started = webview.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        let Ok(core) = controller.CoreWebView2() else {
            let _ = tx.send(Err("failed"));
            return;
        };
        let mut rect = RECT::default();
        let _ = controller.Bounds(&mut rect);
        let (width, height) = (
            (rect.right - rect.left).max(0) as u32,
            (rect.bottom - rect.top).max(0) as u32,
        );
        let Some(stream) = SHCreateMemStream(None) else {
            let _ = tx.send(Err("failed"));
            return;
        };
        let reader = stream.clone();
        let done = tx.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let _ = done.send(match result {
                Ok(()) => read_all(&reader)
                    .map(|jpeg| Shot {
                        jpeg,
                        width,
                        height,
                    })
                    .ok_or("failed"),
                Err(_) => Err("failed"),
            });
            Ok(())
        }));
        capture_start(&core, &stream, &handler, &tx);
    });
    if started.is_err() {
        let _ = failed.send(Err("failed"));
    }
}

unsafe fn capture_start(
    core: &ICoreWebView2,
    stream: &IStream,
    handler: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CapturePreviewCompletedHandler,
    tx: &Sender<Result<Shot, &'static str>>,
) {
    if core
        .CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
            stream,
            handler,
        )
        .is_err()
    {
        let _ = tx.send(Err("failed"));
    }
}

/// 读出内存流里的全部字节。
unsafe fn read_all(stream: &IStream) -> Option<Vec<u8>> {
    let mut size = 0u64;
    stream.Seek(0, STREAM_SEEK_END, Some(&mut size)).ok()?;
    stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
    // 上限:比核心接受的更大就没有意义了,直接放弃
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mut bytes = vec![0u8; size as usize];
    let mut read = 0u32;
    stream
        .Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read))
        .ok()
        .ok()?;
    bytes.truncate(read as usize);
    Some(bytes)
}

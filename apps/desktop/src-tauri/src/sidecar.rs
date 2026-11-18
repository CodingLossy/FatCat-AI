// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! 管理核心 sidecar 子进程:挑空闲回环端口、传环境变量、等 /healthz、退出时关 stdin 并等待。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_GRACE: Duration = Duration::from_secs(10);

pub struct Sidecar {
    pub port: u16,
    child: Child,
    stdin: Option<ChildStdin>,
}

/// 找 sidecar 目录:环境变量 FATCAT_AI_SIDECAR_DIR(开发 / 测试)优先,其次安装包资源里的 `sidecar/`。
fn sidecar_dir(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("FATCAT_AI_SIDECAR_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let dir = resource_dir.ok_or("no resource dir")?.join("sidecar");
    if dir.join("dist/server.mjs").exists() {
        Ok(dir)
    } else {
        Err(format!("sidecar not found at {}", dir.display()))
    }
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn healthy(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream.write_all(b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    let n = stream.read(&mut head).unwrap_or(0);
    head[..n].starts_with(b"HTTP/1.1 200") || head[..n].starts_with(b"HTTP/1.0 200")
}

impl Sidecar {
    pub fn start(data_dir: &Path, resource_dir: Option<&Path>) -> Result<Sidecar, Box<dyn std::error::Error>> {
        let dir = sidecar_dir(resource_dir)?;
        let node = std::env::var("FATCAT_AI_NODE").unwrap_or_else(|_| "node".to_string());
        let port = free_port()?;
        std::fs::create_dir_all(data_dir)?;
        let mut command = Command::new(node);
        command
            .arg(dir.join("dist/server.mjs"))
            .env("FATCAT_AI_HOST", "127.0.0.1")
            .env("FATCAT_AI_PORT", port.to_string())
            .env("FATCAT_AI_DATA_DIR", data_dir)
            .env("FATCAT_AI_EXIT_WITH_PARENT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let web_dir = dir.join("web");
        if web_dir.exists() {
            command.env("FATCAT_AI_WEB_DIR", web_dir);
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let mut sidecar = Sidecar { port, child, stdin };

        let started = Instant::now();
        while started.elapsed() < READY_TIMEOUT {
            if let Some(status) = sidecar.child.try_wait()? {
                return Err(format!("sidecar exited early: {status}").into());
            }
            if healthy(port) {
                return Ok(sidecar);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        sidecar.stop();
        Err("sidecar did not become healthy in time".into())
    }

    /// 关闭 stdin 让核心走正常关闭;超时仍未退出才强杀。
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let started = Instant::now();
        while started.elapsed() < EXIT_GRACE {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_is_bindable_on_loopback() {
        let port = free_port().unwrap();
        assert!(port > 0);
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    }

    #[test]
    fn nothing_is_healthy_on_an_unused_port() {
        let port = free_port().unwrap();
        assert!(!healthy(port));
    }
}

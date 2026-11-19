// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! 管理核心 sidecar 子进程:挑空闲回环端口、传环境变量、等 /healthz、退出时关 stdin 并等待。

use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Windows 进程创建标志:DETACHED_PROCESS 让 sidecar 完全没有控制台。
/// 不能用 CREATE_NO_WINDOW:它会给 node.exe 配一个看不见的 conhost.exe 子进程(仍然「拥有控制台」),
/// 在 Release 版里被 check-windows-install 抓到,用户也可能在任务管理器里看到它。
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
const EXIT_GRACE: Duration = Duration::from_secs(10);

pub struct Sidecar {
    pub port: u16,
    child: Child,
    stdin: Option<ChildStdin>,
}

/// Tauri 在 Windows 上给出的资源目录带 `\\?\` 前缀;Node 用这种路径当入口会报 EISDIR(`lstat 'D:'`)而退出,
/// 所以传给子进程前一律去掉前缀(dunce 只在不改变含义时才去掉;非 Windows 上原样返回)。
fn plain(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

/// 资源目录下 sidecar 目录与自带 node 可执行文件的位置(纯路径计算,不检查文件是否存在)。
fn bundled_paths(resource_dir: &Path) -> (PathBuf, PathBuf) {
    let base = plain(resource_dir);
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    (base.join("sidecar"), base.join("node").join(exe))
}

/// 找 sidecar 目录:环境变量 FATCAT_AI_SIDECAR_DIR(开发 / 测试)优先,其次安装包资源里的 `sidecar/`。
fn sidecar_dir(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("FATCAT_AI_SIDECAR_DIR") {
        return Ok(plain(Path::new(&dir)));
    }
    let dir = bundled_paths(resource_dir.ok_or("no resource dir")?).0;
    if dir.join("dist/server.mjs").exists() {
        Ok(dir)
    } else {
        Err(format!("sidecar not found at {}", dir.display()))
    }
}

/// node 可执行文件:FATCAT_AI_NODE(开发 / 测试)优先,其次安装包资源里的 `node/`,最后退回 PATH 里的 node。
fn node_binary(resource_dir: Option<&Path>) -> PathBuf {
    if let Ok(path) = std::env::var("FATCAT_AI_NODE") {
        return plain(Path::new(&path));
    }
    if let Some(bundled) = resource_dir.map(|dir| bundled_paths(dir).1) {
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from("node")
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
        let node = node_binary(resource_dir);
        let port = free_port()?;
        let data_dir = plain(data_dir);
        std::fs::create_dir_all(&data_dir)?;
        // 启动失败时没有任何线索,所以把 sidecar 的输出写到 <数据目录>/logs/sidecar.log(只在本地,每次启动覆盖)。
        let log_path = data_dir.join("logs").join("sidecar.log");
        std::fs::create_dir_all(data_dir.join("logs"))?;
        let log = File::create(&log_path)?;
        let mut command = Command::new(node);
        command
            .arg(dir.join("dist/server.mjs"))
            .env("FATCAT_AI_HOST", "127.0.0.1")
            .env("FATCAT_AI_PORT", port.to_string())
            .env("FATCAT_AI_DATA_DIR", &data_dir)
            .env("FATCAT_AI_EXIT_WITH_PARENT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        // Windows:sidecar 不挂任何控制台(没有黑窗,也没有 conhost.exe)。它的子进程(邮件 / 文档 worker、MCP、
        // 插件沙箱)由核心用 windowsHide 启动,同样不会弹窗。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(DETACHED_PROCESS);
        }
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
                return Err(format!("sidecar exited early: {status}. Log: {}", log_path.display()).into());
            }
            if healthy(port) {
                return Ok(sidecar);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        sidecar.stop();
        Err(format!("sidecar did not become healthy in time. Log: {}", log_path.display()).into())
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
    fn node_binary_prefers_the_bundled_runtime_and_falls_back_to_path() {
        let dir = std::env::temp_dir().join(format!("fatcat-node-test-{}", std::process::id()));
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::create_dir_all(dir.join("node")).unwrap();
        std::fs::write(dir.join("node").join(exe), b"").unwrap();
        // 测试进程里不设 FATCAT_AI_NODE;若外部设了,这条用例没有意义,直接跳过。
        if std::env::var("FATCAT_AI_NODE").is_err() {
            assert_eq!(node_binary(Some(&dir)), dir.join("node").join(exe));
            assert_eq!(node_binary(None), PathBuf::from("node"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_paths_join_under_the_resource_dir() {
        let (sidecar, node) = bundled_paths(Path::new("/x"));
        assert_eq!(sidecar, Path::new("/x").join("sidecar"));
        assert_eq!(node, Path::new("/x").join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
    }

    /// 回归:Tauri 的资源目录带 `\\?\` 前缀时 Node 会 EISDIR 退出(退出码 101),必须去掉。
    #[cfg(windows)]
    #[test]
    fn verbatim_prefix_is_stripped_from_bundled_paths() {
        let (sidecar, node) = bundled_paths(Path::new(r"\\?\C:\x"));
        assert_eq!(sidecar, PathBuf::from(r"C:\x\sidecar"));
        assert_eq!(node, PathBuf::from(r"C:\x\node\node.exe"));
        // 路径里有空格和中文时同样处理
        let (sidecar, _) = bundled_paths(Path::new(r"\\?\D:\程序 文件\FatCat-AI"));
        assert_eq!(sidecar, PathBuf::from(r"D:\程序 文件\FatCat-AI\sidecar"));
    }

    #[test]
    fn nothing_is_healthy_on_an_unused_port() {
        let port = free_port().unwrap();
        assert!(!healthy(port));
    }
}

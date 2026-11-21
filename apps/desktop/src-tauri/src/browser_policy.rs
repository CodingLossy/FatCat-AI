// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! 内置浏览器面板的导航策略(ADR 0046 第 3.3、3.5 节)。纯逻辑,不依赖 Tauri,可以单独测试。
//!
//! 规则与核心 `browser.open` 的静态检查一致:只放行 https,不带内嵌凭据,拒绝字面 IP(含 `127.1`、`0x7f.1`、
//! 十进制整数这类会被 URL 解析器规范成 IPv4 的写法)、`localhost`、单标签主机名和内部后缀。
//! 解析之后的地址检查(防 DNS 重绑定)需要回环过滤代理,本 PR 没有做(ADR 0046 第 14 节),所以这里的检查只看写在地址里的主机名。

use url::{Host, Url};

/// 拒绝原因;`code()` 是给界面用的稳定码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    /// 不是合法的网址,或是空的。
    BadUrl,
    /// 协议不是 https(http 在 `normalize_address` 里先升级;其余协议如 file / data / blob / javascript 一律拒绝)。
    Scheme,
    /// 地址里带了用户名或密码。
    Credentials,
    /// 字面 IP 地址。
    IpLiteral,
    /// localhost、单标签主机名或内部后缀。
    InternalHost,
}

impl Denied {
    pub fn code(self) -> &'static str {
        match self {
            Denied::BadUrl => "bad_url",
            Denied::Scheme => "bad_scheme",
            Denied::Credentials => "credentials_in_url",
            Denied::IpLiteral => "ip_literal",
            Denied::InternalHost => "internal_host",
        }
    }
}

const INTERNAL_SUFFIXES: &[&str] = &[
    "localhost",
    "local",
    "localdomain",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "home.arpa",
];

/// 没有公网域名形态的主机名:单标签、localhost、内部后缀。
fn internal_name(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    if !host.contains('.') {
        return true;
    }
    INTERNAL_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// 顶层导航的检查(`on_navigation` 与 `browser_navigate` 共用)。
pub fn check_navigation(url: &Url) -> Result<(), Denied> {
    if url.scheme() != "https" {
        return Err(Denied::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Denied::Credentials);
    }
    match url.host() {
        None => Err(Denied::BadUrl),
        Some(Host::Ipv4(_)) | Some(Host::Ipv6(_)) => Err(Denied::IpLiteral),
        Some(Host::Domain(name)) if internal_name(name) => Err(Denied::InternalHost),
        Some(Host::Domain(_)) => Ok(()),
    }
}

/// `协议:内容` 的形态(冒号前是协议名,冒号后不是端口号)。`example.com:8443/x` 是主机加端口,不算。
fn opaque_scheme(text: &str) -> bool {
    let Some((head, rest)) = text.split_once(':') else {
        return false;
    };
    let scheme_like = head.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    scheme_like && !rest.starts_with(|c: char| c.is_ascii_digit())
}

/// 用户输入或模型给的地址 → 经过检查的 https 网址。
/// - 没写协议时补 `https://`;不当作搜索词,带空格的输入一律拒绝。
/// - `http://` 升级成 `https://`(并去掉显式的 80 端口);其他协议拒绝。
pub fn normalize_address(input: &str) -> Result<Url, Denied> {
    let text = input.trim();
    if text.is_empty()
        || text.len() > 2048
        || text.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(Denied::BadUrl);
    }
    let with_scheme = if text.contains("://") {
        text.to_string()
    } else if opaque_scheme(text) {
        // `javascript:alert(1)`、`data:...`、`mailto:x` 这类没有 `//` 的协议不能被当成主机名
        return Err(Denied::Scheme);
    } else if text.starts_with("//") {
        format!("https:{text}")
    } else {
        format!("https://{text}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| Denied::BadUrl)?;
    if url.scheme() == "http" {
        url.set_scheme("https").map_err(|_| Denied::Scheme)?;
        if url.port() == Some(80) {
            url.set_port(None).map_err(|_| Denied::BadUrl)?;
        }
    }
    check_navigation(&url)?;
    Ok(url)
}

/// 只记来源(`scheme://host[:port]`),日志里不放路径、查询串和片段(ADR 0046 第 3.3 节)。
pub fn origin_for_log(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{}://{host}:{port}", url.scheme()),
        (Some(host), None) => format!("{}://{host}", url.scheme()),
        _ => format!("{}:", url.scheme()),
    }
}

/// 调用方的页面是否就是本应用的界面(核心在回环地址上的来源)。浏览器命令只接受这样的调用方。
pub fn is_app_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> String {
        normalize_address(input).unwrap().to_string()
    }
    fn denied(input: &str) -> Denied {
        normalize_address(input).unwrap_err()
    }

    #[test]
    fn accepts_public_https_and_fills_in_the_scheme() {
        assert_eq!(
            ok("https://example.com/a?b=1#c"),
            "https://example.com/a?b=1#c"
        );
        assert_eq!(ok("example.com"), "https://example.com/");
        assert_eq!(ok("//news.example.org/x"), "https://news.example.org/x");
        assert_eq!(ok("https://例え.jp/"), "https://xn--r8jz45g.jp/");
        assert_eq!(ok("example.com:8443/x"), "https://example.com:8443/x");
    }

    #[test]
    fn upgrades_http_and_drops_port_80() {
        assert_eq!(ok("http://example.com/p"), "https://example.com/p");
        assert_eq!(ok("http://example.com:80/p"), "https://example.com/p");
        assert_eq!(
            ok("http://example.com:8080/p"),
            "https://example.com:8080/p"
        );
    }

    #[test]
    fn refuses_other_schemes_and_embedded_credentials() {
        for input in [
            "file:///etc/passwd",
            "data:text/html,<b>x</b>",
            "javascript:alert(1)",
            "blob:https://example.com/x",
            "view-source:https://example.com",
            "ftp://example.com/",
            "mailto:a@example.com",
            "chrome://settings",
            "edge://flags",
        ] {
            assert_eq!(denied(input), Denied::Scheme, "{input}");
        }
        assert_eq!(denied("https://user:pw@example.com/"), Denied::Credentials);
        assert_eq!(denied("https://user@example.com/"), Denied::Credentials);
    }

    #[test]
    fn refuses_every_ip_literal_including_the_odd_spellings() {
        for input in [
            "https://127.0.0.1/",
            "https://127.0.0.1:8787/",
            "https://10.0.0.5/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://8.8.8.8/",
            "https://127.1/",
            "https://0x7f.0.0.1/",
            "https://2130706433/",
            "https://0177.0.0.1/",
            "https://[::ffff:127.0.0.1]/",
        ] {
            assert_eq!(denied(input), Denied::IpLiteral, "{input}");
        }
    }

    #[test]
    fn refuses_internal_names_but_not_lookalikes() {
        for input in [
            "https://localhost/",
            "https://LOCALHOST./",
            "https://intranet/",
            "https://printer.local/",
            "https://nas.home.arpa/",
            "https://app.internal/",
            "https://a.localhost/",
        ] {
            assert_eq!(denied(input), Denied::InternalHost, "{input}");
        }
        assert!(normalize_address("https://notlocal.com/").is_ok());
        assert!(normalize_address("https://my-internal.example.com/").is_ok());
    }

    #[test]
    fn refuses_empty_spaced_and_overlong_input() {
        assert_eq!(denied(""), Denied::BadUrl);
        assert_eq!(denied("   "), Denied::BadUrl);
        assert_eq!(denied("how to cook rice"), Denied::BadUrl);
        assert_eq!(
            denied(&format!("https://example.com/{}", "a".repeat(2100))),
            Denied::BadUrl
        );
        assert_eq!(denied("https://exa mple.com"), Denied::BadUrl);
    }

    #[test]
    fn navigation_filter_is_https_only() {
        // 页面里的重定向和链接走 on_navigation:不会替页面升级 http,而是拒绝
        assert_eq!(
            check_navigation(&Url::parse("http://example.com/").unwrap()),
            Err(Denied::Scheme)
        );
        assert_eq!(
            check_navigation(&Url::parse("https://example.com/").unwrap()),
            Ok(())
        );
        assert_eq!(
            check_navigation(&Url::parse("about:blank").unwrap()),
            Err(Denied::Scheme)
        );
    }

    #[test]
    fn only_the_apps_own_origin_may_call_the_browser_commands() {
        let app = |u: &str| is_app_origin(&Url::parse(u).unwrap(), 8787);
        assert!(app("http://127.0.0.1:8787/#/chat"));
        assert!(!app("http://127.0.0.1:8788/"));
        assert!(!app("http://localhost:8787/"));
        assert!(!app("https://127.0.0.1:8787/"));
        assert!(!app("https://example.com/"));
    }

    #[test]
    fn logs_keep_only_the_origin() {
        let url = Url::parse("https://example.com:8443/secret/path?q=token#frag").unwrap();
        assert_eq!(origin_for_log(&url), "https://example.com:8443");
        assert_eq!(
            origin_for_log(&Url::parse("https://example.com/a?b=c").unwrap()),
            "https://example.com"
        );
    }
}

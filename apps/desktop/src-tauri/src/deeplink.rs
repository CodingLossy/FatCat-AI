// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

//! 深链接白名单(ADR 0044 第 3 节)。只接受两种动作,其余一律忽略:
//! - `fatcat-ai://chat/<会话 id>` → 打开该会话;
//! - `fatcat-ai://ask?text=...` → 打开新对话并把文本预填进输入框(不自动发送)。

use url::Url;

const MAX_ASK_CHARS: usize = 2000;

/// 把深链接翻译成核心 Web UI 里的相对地址(以 `/` 开头);不在白名单内返回 None。
pub fn to_app_path(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "fatcat-ai" {
        return None;
    }
    // fatcat-ai://chat/<id> 解析为 host=chat、path=/<id>;fatcat-ai:///chat/<id> 则 host 为空。
    let (action, rest) = match url.host_str() {
        Some(host) => (host.to_string(), url.path().trim_start_matches('/').to_string()),
        None => {
            let path = url.path().trim_start_matches('/');
            let (a, r) = path.split_once('/').unwrap_or((path, ""));
            (a.to_string(), r.to_string())
        }
    };
    match action.as_str() {
        "chat" => {
            let id = rest.trim_end_matches('/');
            if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
                Some(format!("/s/{id}"))
            } else {
                None
            }
        }
        "ask" => {
            let text = url.query_pairs().find(|(k, _)| k == "text").map(|(_, v)| v.into_owned())?;
            let text: String = text.chars().take(MAX_ASK_CHARS).collect();
            if text.trim().is_empty() {
                return None;
            }
            let mut out = Url::parse("http://x/").ok()?;
            out.query_pairs_mut().append_pair("ask", &text);
            Some(format!("/?{}", out.query()?))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_a_session_by_id() {
        assert_eq!(to_app_path("fatcat-ai://chat/01ABC9"), Some("/s/01ABC9".into()));
        assert_eq!(to_app_path("fatcat-ai:///chat/01ABC9"), Some("/s/01ABC9".into()));
    }

    #[test]
    fn rejects_ids_that_could_escape_the_path() {
        // 点号路径段会被 URL 解析规范化;无论如何结果只能是 /s/<字母数字> 形式,到不了 /settings。
        assert!(to_app_path("fatcat-ai://chat/../settings").map_or(true, |p| p.starts_with("/s/")));
        assert_eq!(to_app_path("fatcat-ai://chat/a/b"), None);
        assert_eq!(to_app_path("fatcat-ai://chat/a%2Fb"), None);
        assert_eq!(to_app_path("fatcat-ai://chat/"), None);
    }

    #[test]
    fn ask_prefills_and_encodes_the_text() {
        assert_eq!(to_app_path("fatcat-ai://ask?text=hi%20there%26more"), Some("/?ask=hi+there%26more".into()));
        assert_eq!(to_app_path("fatcat-ai://ask?text=%20"), None);
        assert_eq!(to_app_path("fatcat-ai://ask"), None);
    }

    #[test]
    fn ignores_every_other_action_and_scheme() {
        assert_eq!(to_app_path("fatcat-ai://settings"), None);
        assert_eq!(to_app_path("fatcat-ai://send?text=hi"), None);
        assert_eq!(to_app_path("https://evil.example/chat/1"), None);
        assert_eq!(to_app_path("not a url"), None);
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 发布前核对(M5c PR 5):仓库里没有 v1.0* tag、没有 GitHub Release、GHCR 上没有该镜像的任何标签。
// 只读,不需要凭据:GHCR 用匿名 pull token 询问标签列表(包不存在或未公开时返回 DENIED,视为「没有公开镜像」)。
//
//   node scripts/check-no-release.mjs [owner/repo]        # 默认 codinglossy/fatcat-ai
// 退出码:0 = 三项都没有;1 = 发现了 tag、Release 或镜像标签;2 = 无法判断(网络错误)。
import { execFileSync } from 'node:child_process';

const slug = (process.argv[2] ?? 'codinglossy/fatcat-ai').toLowerCase();
let found = false;
let unknown = false;
const say = (ok, text) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);

try {
    const out = execFileSync('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*'], { encoding: 'utf8' }).trim();
    say(out === '', out === '' ? 'no v* tags on origin' : `v* tags on origin:\n${out}`);
    if (out !== '') found = true;
} catch (err) {
    unknown = true;
    console.log(`??   could not list remote tags: ${err.message.split('\n')[0]}`);
}

try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'check-no-release' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const releases = await res.json();
    say(releases.length === 0, releases.length === 0 ? 'no GitHub Releases' : `${releases.length} release(s) exist`);
    if (releases.length > 0) found = true;
} catch (err) {
    unknown = true;
    console.log(`??   could not list releases: ${err.message}`);
}

try {
    const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${slug}:pull`);
    const { token } = await tokenRes.json();
    if (!token) {
        say(true, `GHCR ${slug}: no public package (anonymous token denied: package missing or private)`);
    } else {
        const list = await fetch(`https://ghcr.io/v2/${slug}/tags/list`, {
            headers: { authorization: `Bearer ${token}` },
        });
        const body = await list.json().catch(() => ({}));
        const tags = body.tags ?? [];
        say(
            tags.length === 0,
            tags.length === 0 ? `GHCR ${slug}: no tags` : `GHCR ${slug} has tags: ${tags.join(', ')}`,
        );
        if (tags.length > 0) found = true;
    }
} catch (err) {
    unknown = true;
    console.log(`??   could not query GHCR: ${err.message}`);
}

process.exit(found ? 1 : unknown ? 2 : 0);

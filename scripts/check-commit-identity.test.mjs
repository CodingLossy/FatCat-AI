// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-commit-identity.mjs 的自测:在临时仓库里用 git commit-tree 造提交,再对 base..提交 运行检查脚本。
// 运行:node --test scripts/check-commit-identity.test.mjs
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('./check-commit-identity.mjs', import.meta.url).pathname;
const OWNER = { name: '尹绪柏 (Theodore Yin)', email: 'x19169738916@163.com' };
const GITHUB = { name: 'GitHub', email: 'noreply@github.com' };
const BOT = { name: 'Claude', email: 'noreply@anthropic.com' };
const OTHER = { name: 'Someone Else', email: 'someone@example.com' };

let dir;
let base;
let tree;

/** 在临时仓库里造一个提交(不移动任何分支),返回其 SHA。 */
function commit({ author = OWNER, committer = OWNER, message, parents = [base] }) {
    const parentArgs = parents.flatMap((p) => ['-p', p]);
    return execFileSync('git', ['commit-tree', tree, ...parentArgs, '-m', message], {
        cwd: dir,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: committer.name,
            GIT_COMMITTER_EMAIL: committer.email,
        },
    }).trim();
}

/** 对 from..to 运行检查脚本,返回退出码与输出。 */
function check(to, from = base) {
    const result = spawnSync(process.execPath, [SCRIPT, from, to], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'commit-identity-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    tree = execFileSync('git', ['mktree'], { cwd: dir, input: '', encoding: 'utf8' }).trim();
    base = commit({ message: 'chore: initial commit', parents: [] });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('a commit by the owner passes', () => {
    assert.equal(check(commit({ message: 'feat(server): add a thing' })).status, 0);
});

test('a commit whose committer is Claude fails', () => {
    const { status, output } = check(commit({ committer: BOT, message: 'fix: something' }));
    assert.equal(status, 1);
    assert.match(output, /committer name is "Claude"/);
    assert.match(output, /committer mentions claude/);
});

test('a commit whose author is someone else fails', () => {
    assert.equal(check(commit({ author: OTHER, message: 'fix: something' })).status, 1);
});

test('a commit with a Co-authored-by trailer fails', () => {
    const message = 'fix: something\n\nCo-authored-by: Someone Else <someone@example.com>';
    const { status, output } = check(commit({ message }));
    assert.equal(status, 1);
    assert.match(output, /Co-Authored-By trailer/);
});

test('a commit with a "Generated with Claude" attribution fails', () => {
    for (const line of ['Generated with Claude', '🤖 Generated with [Claude Code](https://claude.com/claude-code)']) {
        const { status, output } = check(commit({ message: `docs: something\n\n${line}` }));
        assert.equal(status, 1, line);
        assert.match(output, /Generated with Claude/);
    }
});

test('a commit message that mentions noreply@anthropic.com fails', () => {
    assert.equal(check(commit({ message: 'chore: something\n\nby noreply@anthropic.com' })).status, 1);
});

test('a commit message that only names CLAUDE.md passes', () => {
    assert.equal(check(commit({ message: 'docs: update CLAUDE.md' })).status, 0);
});

test('a web "Update branch" merge commit passes', () => {
    const main = commit({ message: 'feat: on main' });
    const feature = commit({ message: 'feat: on the branch' });
    const merge = commit({
        committer: GITHUB,
        message: "Merge branch 'main' into feat/topic",
        parents: [feature, main],
    });
    const { status, output } = check(merge);
    assert.equal(status, 0, output);
});

test('a merge commit committed by GitHub but authored by someone else fails', () => {
    const main = commit({ message: 'feat: on main' });
    const feature = commit({ message: 'feat: on the branch' });
    const merge = commit({
        author: OTHER,
        committer: GITHUB,
        message: "Merge branch 'main' into feat/topic",
        parents: [feature, main],
    });
    assert.equal(check(merge).status, 1);
});

test('a web-style merge commit with a Co-authored-by trailer fails', () => {
    const main = commit({ message: 'feat: on main' });
    const feature = commit({ message: 'feat: on the branch' });
    const merge = commit({
        committer: GITHUB,
        message: "Merge branch 'main' into feat/topic\n\nCo-authored-by: Someone Else <someone@example.com>",
        parents: [feature, main],
    });
    assert.equal(check(merge).status, 1);
});

test('a single-parent commit committed by GitHub fails', () => {
    assert.equal(check(commit({ committer: GITHUB, message: 'fix: edited on the web' })).status, 1);
});

test('an empty range passes', () => {
    const { status, output } = check(base, base);
    assert.equal(status, 0);
    assert.match(output, /^0 commit\(s\)/);
});

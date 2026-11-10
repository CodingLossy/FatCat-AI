// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 检查 PR 中每个提交的作者、提交者与提交信息(双许可与 CLA 要求代码只有一位作者)。
// 用法:node scripts/check-commit-identity.mjs <base> <head>;不传参数时检查 origin/main..HEAD。
// CI 传入 merge-base(origin/<base 分支>, head.sha) 与 head.sha,而不是事件里的 base.sha:
// base.sha 可能已过期,那样 main 上由 GitHub 生成的合并提交会被算进检查范围。
// 自测:node --test scripts/check-commit-identity.test.mjs
import { execFileSync } from 'node:child_process';

/** 唯一允许的提交身份:作者与提交者的名字、邮箱都必须完全相同。 */
const ALLOWED_NAME = '尹绪柏 (Theodore Yin)';
const ALLOWED_EMAIL = 'x19169738916@163.com';
/** GitHub 网页上 “Update branch” 生成的合并提交使用的提交者。 */
const GITHUB_NAME = 'GitHub';
const GITHUB_EMAIL = 'noreply@github.com';
/** 作者、提交者字段中不允许出现的词(不区分大小写)。 */
const FORBIDDEN_IDENTITY_WORDS = [/claude/i, /anthropic/i];
/**
 * 提交信息中只拦署名类写法;单纯提到文件名或工具名(如 “docs: update CLAUDE.md”)可以通过。
 * 每项为 [正则, 说明]。
 */
const FORBIDDEN_MESSAGE_PATTERNS = [
    [/^[ \t]*co-authored-by[ \t]*:/im, 'a Co-Authored-By trailer'],
    [/^[ \t]*claude-session[ \t]*:/im, 'a Claude-Session trailer'],
    [/generated\s+(?:with|by)\s+\[?\s*claude/i, 'a "Generated with Claude" attribution'],
    [/noreply@anthropic\.com/i, 'noreply@anthropic.com'],
];

const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const shas = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean);

const violations = [];
for (const sha of shas) {
    // 字段以 NUL 分隔,提交信息放最后,可以包含任意字符
    const [an, ae, cn, ce, parents = '', message = ''] = git(
        'show',
        '-s',
        '--format=%an%x00%ae%x00%cn%x00%ce%x00%P%x00%B',
        sha,
    ).split('\0');
    const reasons = [];
    const authorAllowed = an === ALLOWED_NAME && ae === ALLOWED_EMAIL;
    const messageReasons = FORBIDDEN_MESSAGE_PATTERNS.filter(([pattern]) => pattern.test(message)).map(
        ([, what]) => `commit message contains ${what}`,
    );
    // “Update branch” 合并提交:至少两个父提交、作者是允许的身份、提交者是 GitHub、提交信息没有署名。
    // 只有这种提交可以免去提交者检查,其余检查照常。
    const isWebMerge =
        parents.split(' ').filter(Boolean).length >= 2 &&
        authorAllowed &&
        cn === GITHUB_NAME &&
        ce === GITHUB_EMAIL &&
        messageReasons.length === 0;

    if (an !== ALLOWED_NAME) reasons.push(`author name is "${an}"`);
    if (ae !== ALLOWED_EMAIL) reasons.push(`author email is "${ae}"`);
    if (!isWebMerge) {
        if (cn !== ALLOWED_NAME) reasons.push(`committer name is "${cn}"`);
        if (ce !== ALLOWED_EMAIL) reasons.push(`committer email is "${ce}"`);
    }
    for (const word of FORBIDDEN_IDENTITY_WORDS) {
        if (word.test(`${an} ${ae}`)) reasons.push(`author mentions ${word.source}`);
        if (word.test(`${cn} ${ce}`)) reasons.push(`committer mentions ${word.source}`);
    }
    reasons.push(...messageReasons);
    if (reasons.length > 0) violations.push({ sha, reasons });
}

if (violations.length > 0) {
    console.error(`${violations.length} of ${shas.length} commit(s) in ${base}..${head} have a disallowed identity:`);
    for (const { sha, reasons } of violations) {
        for (const reason of reasons) console.error(`  ${sha}: ${reason}`);
    }
    console.error(`Every commit must be authored and committed by ${ALLOWED_NAME} <${ALLOWED_EMAIL}>.`);
    console.error(
        `Only merge commits made by "Update branch" on GitHub may have ${GITHUB_NAME} <${GITHUB_EMAIL}> as committer.`,
    );
    process.exit(1);
}
console.log(`${shas.length} commit(s) in ${base}..${head} checked: all authored and committed by ${ALLOWED_NAME}.`);

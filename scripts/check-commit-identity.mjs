// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 检查 PR 中每个提交的作者、提交者与提交信息(双许可与 CLA 要求代码只有一位作者)。
// 用法:node scripts/check-commit-identity.mjs <base> <head>;不传参数时检查 origin/main..HEAD。
// CI 传入 pull_request 的 base.sha 与 head.sha。base 上已有的提交(包括 main 上由 GitHub 生成的合并提交)
// 不在 base..head 范围内,不会被检查。
import { execFileSync } from 'node:child_process';

/** 唯一允许的提交身份:作者与提交者的名字、邮箱都必须完全相同。 */
const ALLOWED_NAME = '尹绪柏 (Theodore Yin)';
const ALLOWED_EMAIL = 'x19169738916@163.com';
/** 作者、提交者与提交信息中都不允许出现的词(不区分大小写)。 */
const FORBIDDEN_WORDS = [/claude/i, /anthropic/i];
/** 提交信息中不允许的署名尾注。 */
const FORBIDDEN_TRAILER = /co-authored-by/i;

const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const shas = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean);

const violations = [];
for (const sha of shas) {
    // 字段以 NUL 分隔,提交信息放最后,可以包含任意字符
    const [an, ae, cn, ce, message = ''] = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha).split(
        '\0',
    );
    const reasons = [];
    if (an !== ALLOWED_NAME) reasons.push(`author name is "${an}"`);
    if (ae !== ALLOWED_EMAIL) reasons.push(`author email is "${ae}"`);
    if (cn !== ALLOWED_NAME) reasons.push(`committer name is "${cn}"`);
    if (ce !== ALLOWED_EMAIL) reasons.push(`committer email is "${ce}"`);
    if (FORBIDDEN_TRAILER.test(message)) reasons.push('commit message contains a Co-Authored-By trailer');
    for (const word of FORBIDDEN_WORDS) {
        if (word.test(`${an} ${ae}`)) reasons.push(`author mentions ${word.source}`);
        if (word.test(`${cn} ${ce}`)) reasons.push(`committer mentions ${word.source}`);
        if (word.test(message)) reasons.push(`commit message mentions ${word.source}`);
    }
    if (reasons.length > 0) violations.push({ sha, reasons });
}

if (violations.length > 0) {
    console.error(`${violations.length} of ${shas.length} commit(s) in ${base}..${head} have a disallowed identity:`);
    for (const { sha, reasons } of violations) {
        for (const reason of reasons) console.error(`  ${sha}: ${reason}`);
    }
    console.error(`Every commit must be authored and committed by ${ALLOWED_NAME} <${ALLOWED_EMAIL}>.`);
    process.exit(1);
}
console.log(`${shas.length} commit(s) in ${base}..${head} checked: all authored and committed by ${ALLOWED_NAME}.`);

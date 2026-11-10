// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { execFileSync } from 'node:child_process';

/** 返回 git 跟踪的文件与尚未跟踪但未被忽略的文件(相对仓库根目录)。 */
export function listRepoFiles() {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
}

export const AUTHOR = '尹绪柏 (Theodore Yin) <x19169738916@163.com>';
export const COPYRIGHT = 'Copyright (C) 2026 尹绪柏 (Theodore Yin)';

/** 使用 Apache-2.0 的 SDK 包目录(计划第 16 节已定决策 #2)。 */
export const APACHE_DIRS = ['packages/shared/', 'packages/plugin-sdk/', 'packages/client/'];

export function expectedLicense(file) {
    return APACHE_DIRS.some((dir) => file.startsWith(dir)) ? 'Apache-2.0' : 'AGPL-3.0-only';
}

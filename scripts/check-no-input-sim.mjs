// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// M12 不做模拟鼠标键盘(ADR 0046 第 5.4 节):依赖或 Rust crate 里出现合成输入 / 屏幕控制库,或我们自己的代码里
// 出现系统的合成输入调用,就让 CI 失败。以后要做时另开里程碑、另写 ADR,并在那时修改这份清单。
import { readFileSync } from 'node:fs';
import { listRepoFiles } from './lib.mjs';

/** npm 包名与 Rust crate 名(小写)。 */
const BANNED_PACKAGES = [
    'robotjs',
    '@jitsi/robotjs',
    '@nut-tree/nut-js',
    '@nut-tree-fork/nut-js',
    'nut-js',
    'enigo',
    'rdev',
    'autopilot',
    'autopilot-rs',
    'inputbot',
    'pyautogui',
    'mouse-keyboard',
    'iohook',
    'uiohook-napi',
];
/**
 * 源代码里的合成输入调用:Windows SendInput / keybd_event / mouse_event(以及 windows crate 的 KeyboardAndMouse 模块),
 * macOS CGEventPost,X11 XTest。只匹配调用形态,同名的类型(例如邮件的 SendInput 接口)不算。
 */
const BANNED_CALLS = [
    /\bSendInput\s*\(/,
    /\bkeybd_event\s*\(/,
    /\bmouse_event\s*\(/,
    /\bCGEventPost\w*\s*\(/,
    /\bXTestFake\w+/,
    /KeyboardAndMouse/,
];
const SOURCE = /\.(ts|tsx|js|mjs|cjs|rs)$/;
const SELF = 'scripts/check-no-input-sim.mjs';
const MAX_SIZE = 2 * 1024 * 1024;

const hits = [];
for (const file of listRepoFiles()) {
    if (file === SELF) continue;
    // 只读一次,按读到的内容判断大小(先查再读会被 CodeQL 标成检查与使用之间的竞态)
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        continue; // 已删除但还在索引里的文件
    }
    if (text.length > MAX_SIZE) continue;
    const name = file.split('/').pop();
    if (name === 'package.json') {
        const pkg = JSON.parse(text);
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            for (const dep of Object.keys(pkg[field] ?? {})) {
                if (BANNED_PACKAGES.includes(dep.toLowerCase())) hits.push(`${file}: ${field} has ${dep}`);
            }
        }
    } else if (name === 'Cargo.toml' || name === 'Cargo.lock') {
        for (const [i, line] of text.split('\n').entries()) {
            const m = /^\s*(?:name\s*=\s*"([^"]+)"|([A-Za-z0-9_-]+)\s*=)/.exec(line);
            const crate = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
            if (crate && BANNED_PACKAGES.includes(crate)) hits.push(`${file}:${i + 1}: ${crate}`);
            if (/KeyboardAndMouse/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
        }
    } else if (SOURCE.test(file) && !file.includes('/node_modules/')) {
        for (const [i, line] of text.split('\n').entries()) {
            for (const re of BANNED_CALLS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
        }
    }
}

if (hits.length > 0) {
    console.error(hits.join('\n'));
    console.error(`\n发现 ${hits.length} 处模拟输入依赖或调用(ADR 0046 第 5.4 节:M12 不做)`);
    process.exit(1);
}
console.log('模拟输入检查通过');

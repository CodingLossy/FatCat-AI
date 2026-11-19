// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 从 packages/ui/brand 里的 SVG 母版重新生成全部应用图标(M12,docs/design/ui-redesign.md 第 10 节),避免各处图标漂移:
//   node scripts/make-icons.mjs          生成并写入仓库
//   node scripts/make-icons.mjs --check  只比较,生成物与仓库不一致时退出码为 1(CI 用)
// 光栅化用 Tauri CLI 的 `icon` 命令(apps/desktop 已有这个依赖),不新增依赖。
// 24px 以下用「小尺寸版」(只有掌垫和 3 个脚趾、线条加粗),所以 .ico 由这里按尺寸拼装,而不是让 Tauri 缩小母版。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, 'packages/ui/brand');
const tauriBin = join(root, 'apps/desktop/node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const check = process.argv.includes('--check');

/** 把若干 PNG 拼成一个 .ico(每个条目内嵌 PNG,Windows Vista 及以后都支持)。entries: [{ size, png }]。 */
export function buildIco(entries) {
    const sorted = [...entries].sort((a, b) => a.size - b.size);
    const header = Buffer.alloc(6 + 16 * sorted.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sorted.length, 4);
    let offset = header.length;
    sorted.forEach(({ size, png }, i) => {
        const at = 6 + 16 * i;
        header.writeUInt8(size >= 256 ? 0 : size, at);
        header.writeUInt8(size >= 256 ? 0 : size, at + 1);
        header.writeUInt16LE(1, at + 4); // planes
        header.writeUInt16LE(32, at + 6); // bit depth
        header.writeUInt32LE(png.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...sorted.map((e) => e.png)]);
}

/** .icns 内的条目顺序每次生成都可能不同(Tauri 内部用哈希表),只比长度;其余文件逐字节比较。 */
function sameBytes(rel, a, b) {
    return rel.endsWith('.icns') ? a.length === b.length : a.equals(b);
}

function tauriIcon(svg, outDir, pngSizes) {
    const args = ['icon', join(brand, svg), '-o', outDir];
    if (pngSizes) args.push('--png', pngSizes.join(','));
    execFileSync(tauriBin, args, { stdio: 'pipe', cwd: join(root, 'apps/desktop') });
}

function generate(tmp) {
    const out = new Map();
    const read = (dir, name) => readFileSync(join(tmp, dir, name));
    let n = 0;
    const run = (svg, sizes) => {
        const dir = `r${n++}`;
        tauriIcon(svg, join(tmp, dir), sizes);
        return dir;
    };

    const full = run('app-icon.svg'); // .icns、icon.png 与 128px 档
    const big = run('app-icon.svg', [48, 64, 192, 256, 512]);
    const small = run('app-icon-small.svg', [16, 24, 32]);
    const maskable = run('app-icon-maskable.svg', [180, 512]);
    const tray = run('tray-template.svg', [44]);

    const desktop = 'apps/desktop/src-tauri/icons';
    out.set(`${desktop}/icon.icns`, read(full, 'icon.icns'));
    out.set(`${desktop}/icon.png`, read(full, 'icon.png'));
    out.set(`${desktop}/128x128.png`, read(full, '128x128.png'));
    out.set(`${desktop}/128x128@2x.png`, read(full, '128x128@2x.png'));
    out.set(`${desktop}/32x32.png`, read(small, '32x32.png'));
    out.set(
        `${desktop}/icon.ico`,
        buildIco([
            { size: 16, png: read(small, '16x16.png') },
            { size: 24, png: read(small, '24x24.png') },
            { size: 32, png: read(small, '32x32.png') },
            { size: 48, png: read(big, '48x48.png') },
            { size: 64, png: read(big, '64x64.png') },
            { size: 128, png: read(full, '128x128.png') },
            { size: 256, png: read(big, '256x256.png') },
        ]),
    );
    // 托盘:macOS 用单色模板图(系统按亮 / 暗菜单栏着色),Windows / Linux 用 32px 彩色小尺寸版。
    out.set(`${desktop}/tray/tray-template.png`, read(tray, '44x44.png'));
    out.set(`${desktop}/tray/tray-32.png`, read(small, '32x32.png'));

    const web = 'apps/web/public/icons';
    out.set(`${web}/icon-192.png`, read(big, '192x192.png'));
    out.set(`${web}/icon-512.png`, read(big, '512x512.png'));
    out.set(`${web}/icon-maskable-512.png`, read(maskable, '512x512.png'));
    out.set(`${web}/apple-touch-icon.png`, read(maskable, '180x180.png'));
    out.set(`${web}/favicon-32.png`, read(small, '32x32.png'));
    for (const [file, name] of [
        ['app-icon.svg', 'app-icon.svg'],
        ['app-icon-small.svg', 'favicon.svg'],
        ['avatar.svg', 'avatar.svg'],
    ]) {
        out.set(`${web}/${name}`, readFileSync(join(brand, file)));
    }
    return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    if (!existsSync(tauriBin)) {
        console.error('make-icons: run `pnpm install` first (needs the Tauri CLI in apps/desktop)');
        process.exit(1);
    }
    const tmp = mkdtempSync(join(tmpdir(), 'fatcat-icons-'));
    try {
        const out = generate(tmp);
        const stale = [];
        for (const [rel, bytes] of out) {
            const target = join(root, rel);
            if (check) {
                if (!existsSync(target) || !sameBytes(rel, readFileSync(target), bytes)) stale.push(rel);
            } else {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, bytes);
            }
        }
        if (check && stale.length > 0) {
            console.error(
                `make-icons: generated files are out of date, run \`node scripts/make-icons.mjs\`:\n  ${stale.join('\n  ')}`,
            );
            process.exit(1);
        }
        console.log(check ? `icons are up to date (${out.size} files)` : `wrote ${out.size} icon files`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

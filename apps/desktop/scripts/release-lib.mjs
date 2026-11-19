// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 发布脚本共用的纯函数:安装包体积检查、SHA256SUMS 生成、Node 下载地址。

import { createHash } from 'node:crypto';

export const MAX_INSTALLER_BYTES = 80 * 1024 * 1024;
/** AppImage 自带 WebKitGTK 等共享库(deb / rpm 依赖系统库),所以单独放宽,见 ADR 0044 第 7 节。其他格式仍是 80 MB。 */
export const MAX_APPIMAGE_BYTES = 100 * 1024 * 1024;

export function limitFor(name, limit = MAX_INSTALLER_BYTES) {
    return name.toLowerCase().endsWith('.appimage') && limit === MAX_INSTALLER_BYTES ? MAX_APPIMAGE_BYTES : limit;
}
export const INSTALLER_EXTENSIONS = ['.msi', '.exe', '.dmg', '.deb', '.rpm', '.appimage'];

export function isInstaller(name) {
    const lower = name.toLowerCase();
    return INSTALLER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** files: [{ name, size }]。返回超过上限的文件;没有任何安装包也算错误(构建产物路径变了会静默通过)。 */
export function checkInstallerSizes(files, limit = MAX_INSTALLER_BYTES) {
    const installers = files.filter((f) => isInstaller(f.name));
    const errors = [];
    if (installers.length === 0) errors.push('no installer found');
    for (const f of installers) {
        const max = limitFor(f.name, limit);
        if (f.size > max) errors.push(`${f.name}: ${(f.size / 1048576).toFixed(1)} MB exceeds ${max / 1048576} MB`);
    }
    return { installers, errors };
}

/** entries: [{ name, bytes }] → "<sha256>  <name>\n" 逐行(与 sha256sum / shasum -a 256 的输出格式一致),按名字排序。 */
export function sha256Sums(entries) {
    return (
        [...entries]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((e) => `${createHash('sha256').update(e.bytes).digest('hex')}  ${e.name}`)
            .join('\n') + '\n'
    );
}

/** 官方 Node 发行包:返回下载文件名与其中 node 可执行文件的相对路径。 */
export function nodeDistribution(version, platform, arch) {
    // 版本号只允许 x.y.z,下载地址的主机固定为 nodejs.org,配置文件里的内容不能改变请求的目标。
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) throw new Error(`invalid Node version: ${version}`);
    if (!/^(darwin|linux|win32)$/.test(platform) || !/^(x64|arm64)$/.test(arch))
        throw new Error('unsupported platform');
    const target = `${platform}-${arch}`;
    const slug = platform === 'win32' ? `win-${arch}` : target;
    const ext = platform === 'win32' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz';
    const dir = `node-v${version}-${slug}`;
    return {
        target,
        file: `${dir}.${ext}`,
        url: `https://nodejs.org/dist/v${version}/${dir}.${ext}`,
        inner: platform === 'win32' ? `${dir}/node.exe` : `${dir}/bin/node`,
        exe: platform === 'win32' ? 'node.exe' : 'node',
    };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// SSRF 防护:判断一个 IP 是否属于不允许访问的范围(回环、私网、链路本地、云元数据、保留地址等)。
import { isIP } from 'node:net';

type Range = [base: bigint, bits: number];

function ipv4ToBigInt(ip: string): bigint {
    return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** 展开 IPv6(含 :: 缩写与末尾的点分 IPv4)为 128 位整数。 */
function ipv6ToBigInt(ip: string): bigint {
    let text = ip.toLowerCase().split('%')[0]!;
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (v4) {
        const n = ipv4ToBigInt(v4[1]!);
        text = text.slice(0, -v4[1]!.length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
    }
    const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
    const headParts = head ? head.split(':').filter((p) => p !== '') : [];
    const tailParts = tail ? tail.split(':').filter((p) => p !== '') : [];
    const missing = 8 - headParts.length - tailParts.length;
    const parts = [...headParts, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...tailParts];
    return parts.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n);
}

const v4 = (cidr: string): Range => {
    const [ip, bits] = cidr.split('/');
    return [ipv4ToBigInt(ip!), Number(bits)];
};
const v6 = (cidr: string): Range => {
    const [ip, bits] = cidr.split('/');
    return [ipv6ToBigInt(ip!), Number(bits)];
};

/** 不允许访问的 IPv4 范围(RFC 6890 等)。 */
const BLOCKED_V4: Range[] = [
    '0.0.0.0/8', // 本网络
    '10.0.0.0/8', // 私网
    '100.64.0.0/10', // 运营商级 NAT
    '127.0.0.0/8', // 回环
    '169.254.0.0/16', // 链路本地,含云元数据 169.254.169.254
    '172.16.0.0/12', // 私网
    '192.0.0.0/24', // IETF 协议分配
    '192.0.2.0/24', // 文档
    '192.88.99.0/24', // 6to4 中继
    '192.168.0.0/16', // 私网
    '198.18.0.0/15', // 基准测试
    '198.51.100.0/24', // 文档
    '203.0.113.0/24', // 文档
    '224.0.0.0/4', // 组播
    '240.0.0.0/4', // 保留,含广播
].map(v4);

/** 不允许访问的 IPv6 范围;IPv4 映射 / NAT64 地址另按其中的 IPv4 判断。 */
const BLOCKED_V6: Range[] = [
    '::/128', // 未指定
    '::1/128', // 回环
    '100::/64', // 丢弃
    '2001:db8::/32', // 文档
    '2001::/23', // IETF 协议分配(含 Teredo)
    '2002::/16', // 6to4
    'fc00::/7', // 唯一本地,含 fd00:ec2::254 一类的元数据地址
    'fe80::/10', // 链路本地
    'fec0::/10', // 站点本地(已废弃)
    'ff00::/8', // 组播
].map(v6);

const inRange = (value: bigint, [base, bits]: Range, width: number) => {
    const shift = BigInt(width - bits);
    return value >> shift === base >> shift;
};

/** IP 是否不允许访问;不是合法 IP 时也返回 true(默认拒绝)。 */
export function isBlockedAddress(ip: string): boolean {
    const family = isIP(ip.split('%')[0]!);
    if (family === 4) {
        const n = ipv4ToBigInt(ip);
        return BLOCKED_V4.some((r) => inRange(n, r, 32));
    }
    if (family === 6) {
        const n = ipv6ToBigInt(ip);
        // ::ffff:a.b.c.d(IPv4 映射)与 64:ff9b::/32 内的 NAT64 地址(RFC 6052、8215)按内嵌的 IPv4 判断
        const embedded = n & 0xffffffffn;
        if (n >> 32n === 0xffffn || n >> 96n === 0x64ff9bn) {
            const dotted = [24n, 16n, 8n, 0n].map((s) => String((embedded >> s) & 0xffn)).join('.');
            return isBlockedAddress(dotted);
        }
        // ::a.b.c.d(已废弃的 IPv4 兼容地址)
        if (n >> 32n === 0n) return true;
        return BLOCKED_V6.some((r) => inRange(n, r, 128));
    }
    return true;
}

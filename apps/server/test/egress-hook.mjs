// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 外连一致性测试用的钩子(ADR 0028 第 2 节),只在测试里使用,不参与构建。
// 记录进程里真实发起的外连目的地,并且不让任何连接真的出去:
//   - net.Socket.prototype.connect(IMAP / SMTP 的 TCP 与 TLS 都经过它;unix 套接字与管道不记录)
//   - globalThis.fetch(返回 404,不发请求)
// 既可以在测试进程里 install(sink) 使用,也可以作为 `node --import` 预加载到邮件子进程:
// 设置了环境变量 EGRESS_LOG 时,预加载会把每条记录追加写入该文件(一行一个 JSON)。
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

// 有些客户端(nodemailer)先自己解析主机名再连 IP。这里给每个主机名一个固定的假地址(TEST-NET-1),
// 连接时再换回主机名,这样记录的始终是配置里的主机名,也不需要真实的 DNS。
const fakeByHost = new Map();
const hostByFake = new Map();
function fakeAddress(host) {
    const name = String(host).toLowerCase();
    if (net.isIP(name)) return name;
    let ip = fakeByHost.get(name);
    if (!ip) {
        ip = `192.0.2.${fakeByHost.size + 1}`;
        fakeByHost.set(name, ip);
        hostByFake.set(ip, name);
    }
    return ip;
}

/** 解析 Socket.connect 的参数,只关心 TCP 目的地。 */
function tcpDestination(socket, args) {
    const first = args[0];
    if (Array.isArray(first)) return destinationFrom(socket, first[0]);
    return destinationFrom(socket, first, args[1]);
}

function destinationFrom(socket, first, second) {
    let host;
    let port;
    if (first !== null && typeof first === 'object') {
        if (first.path) return null;
        host = first.host ?? 'localhost';
        port = first.port;
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
        port = first;
        host = typeof second === 'string' ? second : 'localhost';
    } else {
        return null; // 路径形式的本机套接字
    }
    return {
        kind: 'socket',
        host: hostByFake.get(String(host)) ?? String(host).toLowerCase(),
        port: Number(port),
        secure: socket instanceof tls.TLSSocket,
    };
}

/** 安装钩子;返回卸载函数。 */
export function install(sink) {
    const realConnect = net.Socket.prototype.connect;
    const realFetch = globalThis.fetch;
    const realLookup = dns.lookup;
    const realResolve4 = dns.Resolver.prototype.resolve4;
    const realResolve6 = dns.Resolver.prototype.resolve6;
    dns.Resolver.prototype.resolve4 = function (host, ...rest) {
        const cb = rest.at(-1);
        process.nextTick(() => cb(null, [fakeAddress(host)]));
        return undefined;
    };
    dns.Resolver.prototype.resolve6 = function (_host, ...rest) {
        const cb = rest.at(-1);
        process.nextTick(() => cb(null, []));
        return undefined;
    };
    dns.lookup = function (host, options, cb) {
        const done = typeof options === 'function' ? options : cb;
        const all = typeof options === 'object' && options !== null && options.all;
        const ip = fakeAddress(host);
        process.nextTick(() => (all ? done(null, [{ address: ip, family: 4 }]) : done(null, ip, 4)));
    };
    net.Socket.prototype.connect = function (...args) {
        const destination = tcpDestination(this, args);
        if (!destination) return realConnect.apply(this, args);
        sink(destination);
        process.nextTick(() => this.destroy(new Error('egress hook: connection blocked')));
        return this;
    };
    globalThis.fetch = (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        sink({ kind: 'fetch', url });
        return Promise.resolve(new Response('not found', { status: 404 }));
    };
    return () => {
        net.Socket.prototype.connect = realConnect;
        dns.lookup = realLookup;
        dns.Resolver.prototype.resolve4 = realResolve4;
        dns.Resolver.prototype.resolve6 = realResolve6;
        globalThis.fetch = realFetch;
    };
}

if (process.env.EGRESS_LOG) {
    const file = process.env.EGRESS_LOG;
    install((record) => appendFileSync(file, `${JSON.stringify(record)}\n`));
}

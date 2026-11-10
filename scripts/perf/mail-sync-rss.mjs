// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 万封邮件同步后的内存回落压测(ADR 0018 第 4 节,开发计划 M3.x)。
// 起一个本地假 IMAP 服务器(TLS,自签证书)与构建好的服务器(apps/server/dist),
// 用 REST 建账户并同步到底,测主进程内存:同步前、同步后、空闲 60 秒后;删除账户重建,连跑 RUNS 次。
// Linux 读 /proc/<pid>/status 的 VmRSS;Windows 用 Get-Process 的 WorkingSet64(判定用)与 PrivateMemorySize64(只显示)。
// 需要 openssl:OPENSSL 指定路径;否则 Windows 上从 `git --exec-path` / `where git` 找 Git for Windows 自带的那个;
// 也可以用 TLS_KEY / TLS_CERT 指定现成的证书。
//
// 自己起服务器(先运行 `pnpm build`):
//   node scripts/perf/mail-sync-rss.mjs            # 1 万封,3 次
//   MAILS=2000 RUNS=1 SETTLE_S=10 node scripts/perf/mail-sync-rss.mjs
//   NODE_FLAGS='--max-old-space-size=384' node scripts/perf/mail-sync-rss.mjs   # 换 Node 参数(如对比修复前)
//   CHECK=1 node scripts/perf/mail-sync-rss.mjs   # 按 ADR 0018 规则 3、4 判定,不满足时退出码 1(CI 用)
//
// 连接已运行的服务器(例如 `pnpm dev`;建议用单独的数据目录,脚本会在其中建、删一个 perf 邮件账户):
//   ATTACH=http://127.0.0.1:8787 FATCAT_AI_PERF_USER=owner FATCAT_AI_PERF_PASSWORD=... node scripts/perf/mail-sync-rss.mjs
//   第一次运行会在 TLS_DIR(默认系统临时目录下的 fatcat-perf-tls)生成证书,并提示启动服务器时要带的两个环境变量:
//   NODE_EXTRA_CA_CERTS=<证书> 与 FATCAT_AI_PERF_MAIL_PASSWORD=<任意值>。主进程 PID 按端口自动查找,也可用 SERVER_PID 指定。
//   PowerShell 中先 `$env:ATTACH='http://127.0.0.1:8787'` 等再运行。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startFakeImap } from './fake-imap.mjs';

const MAILS = Number(process.env.MAILS ?? 10_000);
const RUNS = Number(process.env.RUNS ?? 3);
const SETTLE_S = Number(process.env.SETTLE_S ?? 60);
const SAMPLE_GAP_MS = Number(process.env.SAMPLE_GAP_MS ?? 5000);
const CHECK = process.env.CHECK === '1';
const ATTACH = process.env.ATTACH?.replace(/\/+$/, '');
const WINDOWS = process.platform === 'win32';
/** ADR 0018 第 2 节:规则 3(空闲 60 秒后 − 负载前空闲)与规则 4(第 3 次 − 第 2 次)的上限。 */
const ROLLBACK_LIMIT_MIB = 60;
const CREEP_LIMIT_MIB = 5;
const root = fileURLToPath(new URL('../../', import.meta.url));

if (process.platform !== 'linux' && !WINDOWS) {
    console.error('mail-sync-rss: only Linux and Windows are supported');
    process.exit(2);
}

/**
 * 与容器一致的 Node 参数:默认取自 docker/Dockerfile 的 NODE_OPTIONS,改了 Dockerfile 这里自动跟上;
 * 环境变量 NODE_FLAGS 可以覆盖(空格分隔)。连接已运行的服务器时不用。
 */
const NODE_FLAGS = (
    process.env.NODE_FLAGS ??
    /NODE_OPTIONS="([^"]+)"/.exec(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'))?.[1] ??
    ''
)
    .split(/\s+/)
    .filter(Boolean);

const round1 = (n) => Math.round(n * 10) / 10;
const powershell = (command) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();

/** 主进程内存(MiB):rss 用于判定;Windows 上另给 private(提交的私有内存),只显示。 */
function memory(pid) {
    if (WINDOWS) {
        const [ws, priv] = powershell(
            `$p = Get-Process -Id ${Number(pid)}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`,
        ).split(/\s+/);
        return { rss: round1(Number(ws) / 1048576), private: round1(Number(priv) / 1048576) };
    }
    const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return { rss: round1(Number(kb) / 1024) };
}

/** 3 次采样的中位数(ADR 0018 第 4 节)。 */
async function sample(pid) {
    const values = [];
    for (let i = 0; i < 3; i++) {
        if (i > 0) await sleep(SAMPLE_GAP_MS);
        values.push(memory(pid));
    }
    return values.sort((a, b) => a.rss - b.rss)[1];
}
const show = (m) => (m.private === undefined ? `${m.rss} MiB` : `${m.rss} MiB (private ${m.private} MiB)`);

/** Linux:/proc/net/tcp{,6} 里找监听该端口的 socket inode,再在 /proc/<pid>/fd 中找持有它的进程(不依赖 ss)。 */
function linuxPidByPort(port) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const inodes = new Set();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f[1]?.endsWith(`:${hex}`) && f[3] === '0A') inodes.add(f[9]);
        }
    }
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        try {
            for (const fd of readdirSync(`/proc/${pid}/fd`)) {
                const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
                if (m && inodes.has(m[1])) return pid;
            }
        } catch {
            /* 别人的进程或已退出 */
        }
    }
    return '';
}

/** 按监听端口找主进程 PID(`pnpm dev` 时真正监听的是 node --watch 的子进程)。 */
function pidByPort(port) {
    const out = WINDOWS
        ? powershell(
              `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1).OwningProcess`,
          )
        : linuxPidByPort(Number(port));
    const pid = Number(out);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no process listening on port ${port}; set SERVER_PID`);
    return pid;
}

function freePort() {
    return new Promise((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

/** Git for Windows 的安装目录:先看 `git --exec-path`(<Git>\\mingw64\\libexec\\git-core),再看 `where git`(<Git>\\cmd\\git.exe)。 */
function gitRoots() {
    const roots = [];
    const tryRun = (cmd, args) => {
        try {
            return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return '';
        }
    };
    const execPath = tryRun('git', ['--exec-path']);
    if (execPath) roots.push(resolve(execPath, '..', '..', '..'));
    for (const line of tryRun('where.exe', ['git']).split(/\r?\n/).filter(Boolean))
        roots.push(resolve(line, '..', '..'));
    roots.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git'));
    return [...new Set(roots)];
}

/** openssl 可执行文件:OPENSSL 环境变量优先;Windows 上再找 Git for Windows 自带的那个。 */
function findOpenssl() {
    if (process.env.OPENSSL) return process.env.OPENSSL;
    if (!WINDOWS) return 'openssl';
    const candidates = gitRoots().flatMap((root) => [
        join(root, 'usr', 'bin', 'openssl.exe'),
        join(root, 'mingw64', 'bin', 'openssl.exe'),
    ]);
    return candidates.find((p) => existsSync(p)) ?? 'openssl';
}

/** 自签证书:TLS_KEY / TLS_CERT 指定时直接用;否则在 tlsDir 下生成(已存在则复用)。 */
function ensureCert(tlsDir) {
    if (process.env.TLS_KEY && process.env.TLS_CERT)
        return { keyPath: process.env.TLS_KEY, certPath: process.env.TLS_CERT };
    const keyPath = join(tlsDir, 'key.pem');
    const certPath = join(tlsDir, 'cert.pem');
    if (existsSync(keyPath) && existsSync(certPath)) return { keyPath, certPath };
    mkdirSync(tlsDir, { recursive: true });
    // MSYS_NO_PATHCONV:Git for Windows 的 openssl 不要把 /CN=localhost 当成路径改写
    execFileSync(
        findOpenssl(),
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '30',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost',
            '-keyout',
            keyPath,
            '-out',
            certPath,
        ],
        { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    return { keyPath, certPath };
}

const dir = mkdtempSync(join(tmpdir(), 'fatcat-mail-rss-'));
const tlsDir = ATTACH ? (process.env.TLS_DIR ?? join(tmpdir(), 'fatcat-perf-tls')) : dir;
const hadCert = existsSync(join(tlsDir, 'cert.pem'));
let keyPath;
let certPath;
try {
    ({ keyPath, certPath } = ensureCert(tlsDir));
} catch (err) {
    // 证书生成失败(例如找不到 openssl)时不留下临时目录
    rmSync(dir, { recursive: true, force: true });
    console.error(
        `mail-sync-rss: cannot create a self-signed certificate (${err.message}); set OPENSSL or TLS_KEY / TLS_CERT`,
    );
    process.exit(2);
}
if (ATTACH && !hadCert && !(process.env.TLS_KEY && process.env.TLS_CERT)) {
    rmSync(dir, { recursive: true, force: true });
    const vars = { NODE_EXTRA_CA_CERTS: certPath, FATCAT_AI_PERF_MAIL_PASSWORD: 'fake-password' };
    console.log(`Generated a self-signed certificate in ${tlsDir}.`);
    console.log('Start the server with these environment variables, then run this script again:');
    for (const [name, value] of Object.entries(vars))
        console.log(WINDOWS ? `  $env:${name}='${value.replace(/'/g, "''")}'` : `  export ${name}='${value}'`);
    process.exit(2);
}

const imap = await startFakeImap({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    counts: { INBOX: MAILS, Sent: 0 },
});

let server = null;
let origin;
if (ATTACH) {
    origin = ATTACH.replace(/\/api\/v1$/, '');
} else {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [...NODE_FLAGS, 'dist/index.js'], {
        cwd: join(root, 'apps/server'),
        env: {
            ...process.env,
            NODE_ENV: 'production',
            FATCAT_AI_HOST: '127.0.0.1',
            FATCAT_AI_PORT: String(port),
            FATCAT_AI_DATA_DIR: join(dir, 'data'),
            FATCAT_AI_LOG_LEVEL: 'warn',
            NODE_EXTRA_CA_CERTS: certPath,
            FATCAT_AI_PERF_MAIL_PASSWORD: 'fake-password',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
}
const base = `${origin}/api/v1`;

let cookie = '';
let csrf = '';
async function api(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie();
    if (set.length > 0) {
        const pairs = set.map((c) => c.split(';')[0]);
        cookie = pairs.join('; ');
        csrf = pairs.find((p) => p.startsWith('aip_csrf='))?.slice('aip_csrf='.length) ?? csrf;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

const account = {
    label: 'perf',
    address: 'owner@example.test',
    username: 'owner@example.test',
    passwordRef: 'env:FATCAT_AI_PERF_MAIL_PASSWORD',
    imap: { host: 'localhost', port: imap.port, security: 'tls' },
    smtp: { host: 'localhost', port: 1, security: 'tls' },
    initialSyncDays: 30,
};

/** 结束子进程与假服务器,删除临时目录;正常结束与 Ctrl+C / SIGTERM 都走这里,只执行一次。连接模式不停服务器。 */
let cleaned = false;
let accountId = null;
async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (ATTACH && accountId) await api('DELETE', `/mail/accounts/${accountId}`).catch(() => undefined);
    server?.kill();
    await imap.close();
    rmSync(dir, { recursive: true, force: true });
}
// 按惯例退出码为 128 + 信号编号:SIGINT 130,SIGTERM 143
for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
]) {
    process.once(signal, () => {
        void cleanup().finally(() => process.exit(code));
    });
}

const results = [];
try {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${origin}/healthz`)).ok) break;
        } catch {
            /* 还没起来 */
        }
        await sleep(200);
    }
    let pid;
    if (ATTACH) {
        const user = process.env.FATCAT_AI_PERF_USER;
        const password = process.env.FATCAT_AI_PERF_PASSWORD;
        if (!user || !password) throw new Error('ATTACH needs FATCAT_AI_PERF_USER and FATCAT_AI_PERF_PASSWORD');
        await api('POST', '/auth/login', { username: user, password });
        pid = Number(process.env.SERVER_PID ?? pidByPort(new URL(origin).port || 80));
        console.log(`attached to ${origin}, pid ${pid}`);
    } else {
        await api('POST', '/auth/setup', { username: 'owner', password: 'perf-test-password-1' });
        await sleep(10_000); // 与 CI 的空闲测量一致:启动后 10 秒
        pid = server.pid;
        console.log(`node flags: ${NODE_FLAGS.join(' ')}`);
    }
    const idle = await sample(pid);
    console.log(`idle before load: ${show(idle)}`);

    for (let run = 1; run <= RUNS; run++) {
        const created = await api('POST', '/mail/accounts', account);
        accountId = created.id;
        const started = Date.now();
        let added = 0;
        let peak = 0;
        let lastPeakAt = 0;
        for (;;) {
            const r = await api('POST', `/mail/accounts/${created.id}/sync`);
            if (!r.ok) throw new Error(`sync failed: ${r.error}`);
            added += r.added;
            // Windows 每次读内存要起一个 powershell,至多 2 秒一次,免得拖慢吞吐
            if (!WINDOWS || Date.now() - lastPeakAt > 2000 || !r.more) {
                peak = Math.max(peak, memory(pid).rss);
                lastPeakAt = Date.now();
            }
            if (!r.more) break;
        }
        if (added !== MAILS) throw new Error(`run ${run}: expected ${MAILS} mails, synced ${added}`);
        const seconds = Math.round((Date.now() - started) / 1000);
        const perSecond = Math.round(added / Math.max(1, (Date.now() - started) / 1000));
        const after = await sample(pid);
        await sleep(SETTLE_S * 1000);
        const settled = await sample(pid);
        results.push({
            run,
            added,
            seconds,
            perSecond,
            peak,
            after: after.rss,
            settled: settled.rss,
            settledMem: settled,
        });
        console.log(
            `run ${run}: ${added} mails in ${seconds}s (${perSecond}/s), peak ${peak}, after ${after.rss}, after ${SETTLE_S}s ${show(settled)}`,
        );
        await api('DELETE', `/mail/accounts/${created.id}`);
        accountId = null;
    }
    console.log(
        JSON.stringify({
            mails: MAILS,
            platform: process.platform,
            attached: Boolean(ATTACH),
            idle: idle.rss,
            ...(idle.private === undefined ? {} : { idlePrivate: idle.private }),
            settleSeconds: SETTLE_S,
            runs: results.map(({ settledMem, ...r }) =>
                settledMem.private === undefined ? r : { ...r, settledPrivate: settledMem.private },
            ),
        }),
    );
    if (CHECK) {
        const errors = [];
        for (const r of results) {
            const delta = round1(r.settled - idle.rss);
            if (delta > ROLLBACK_LIMIT_MIB)
                errors.push(
                    `run ${r.run}: ${delta} MiB above idle after ${SETTLE_S}s (limit ${ROLLBACK_LIMIT_MIB}, ADR 0018 rule 3)`,
                );
        }
        if (results.length >= 3) {
            const creep = round1(results[2].settled - results[1].settled);
            if (creep > CREEP_LIMIT_MIB)
                errors.push(`run 3 is ${creep} MiB above run 2 (limit ${CREEP_LIMIT_MIB}, ADR 0018 rule 4)`);
        } else {
            console.log(`ADR 0018 rule 4: skipped (needs RUNS >= 3, got ${results.length})`);
        }
        for (const e of errors) console.log(`::error::${e}`);
        if (errors.length === 0) console.log(`ADR 0018 ${results.length >= 3 ? 'rules 3 and 4' : 'rule 3'}: passed`);
        process.exitCode = errors.length > 0 ? 1 : 0;
    }
} finally {
    await cleanup();
}

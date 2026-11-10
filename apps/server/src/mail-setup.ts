// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件同步的调度(ADR 0016 第 2 节):定时拉取,每个账户一把锁,全局并发 1,失败指数退避。
// 网络与解析在 worker 中完成(@ai-personal/mail 的 runInWorker),主进程只写数据库。
import type { MailConnectionTest, MailSyncResult } from '@ai-personal/shared';
import { type MailJobRunner, ownThreadKey, runInWorker } from '@ai-personal/mail';
import type { MailAccountRecord, MailFolderSync, Repositories } from '@ai-personal/storage';
import type { SecretStore } from '@ai-personal/providers';

/** 每分钟检查一次哪些账户到了同步时间。 */
export const MAIL_TICK_MS = 60_000;
/** 启动后等一会儿再开始第一次同步,不和启动抢资源。 */
const FIRST_TICK_MS = 15_000;

export interface MailService {
    /** 立即同步一个账户;同一账户已在同步时等待并返回那一次的结果。 */
    sync(ownerId: string, accountId: string): Promise<MailSyncResult>;
    /** 测试 IMAP 与 SMTP 登录,不发送邮件。 */
    test(ownerId: string, accountId: string): Promise<MailConnectionTest>;
    /** 同步所有到期的账户(定时器调用;测试中直接调用)。 */
    tick(): Promise<void>;
    /** 执行邮件任务(同步、发送、下载附件)的函数;默认是子进程。 */
    readonly runner: MailJobRunner;
    start(): void;
    stop(): void;
}

export interface MailServiceOptions {
    repos: Repositories;
    secrets: Pick<SecretStore, 'resolve'>;
    redact: (text: string) => string;
    /** 默认在 worker 中运行;测试中注入内存实现。 */
    runner?: MailJobRunner;
    now?: () => Date;
    onError?: (error: unknown, context: { accountId: string }) => void;
}

class MailSyncError extends Error {}

export function createMailService(options: MailServiceOptions): MailService {
    const { repos, redact } = options;
    const runner = options.runner ?? runInWorker;
    const now = options.now ?? (() => new Date());
    const inFlight = new Map<string, Promise<MailSyncResult>>();
    let queue: Promise<unknown> = Promise.resolve();
    let timer: ReturnType<typeof setInterval> | null = null;
    let first: ReturnType<typeof setTimeout> | null = null;
    let ticking: Promise<void> | null = null;

    const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 500);

    function password(account: MailAccountRecord): string {
        const value = options.secrets.resolve(account.passwordRef);
        if (!value) throw new MailSyncError(`The password referenced by ${account.passwordRef} is not set.`);
        return value;
    }

    async function runSync(ownerId: string, accountId: string): Promise<MailSyncResult> {
        const account = repos.mail.get(ownerId, accountId);
        if (!account)
            return { ok: false, error: 'The account was removed.', added: 0, updated: 0, removed: 0, more: false };
        try {
            const output = await runner({
                kind: 'sync',
                input: {
                    server: account.imap,
                    username: account.username,
                    password: password(account),
                    initialSyncDays: account.initialSyncDays,
                    folders: repos.mail.knownFolders(accountId),
                    now: now().toISOString(),
                },
            });
            const folders: MailFolderSync[] = output.folders.map((f) => ({
                ...f,
                messages: f.messages.map((m) => ({
                    ...m,
                    threadKey: ownThreadKey({
                        references: m.references,
                        inReplyTo: m.inReplyTo,
                        subject: m.subject,
                        participants: [m.from, ...m.to, ...m.cc].flatMap((a) => (a ? [a.address] : [])),
                    }),
                })),
            }));
            const counts = repos.mail.applySync(accountId, folders);
            const more = output.folders.some((f) => f.more);
            repos.mail.recordSync(accountId, { ok: true, intervalMinutes: account.syncIntervalMinutes, soon: more });
            return { ok: true, error: null, ...counts, more };
        } catch (error) {
            const text = message(error);
            // 账户可能在同步期间被删除:这时不再记录
            if (repos.mail.get(ownerId, accountId)) {
                repos.mail.recordSync(accountId, {
                    ok: false,
                    error: text,
                    intervalMinutes: account.syncIntervalMinutes,
                });
                options.onError?.(error, { accountId });
            }
            return { ok: false, error: text, added: 0, updated: 0, removed: 0, more: false };
        }
    }

    function sync(ownerId: string, accountId: string): Promise<MailSyncResult> {
        const running = inFlight.get(accountId);
        if (running) return running;
        // 全局并发 1:排在前一个同步之后
        const job = queue.then(() => runSync(ownerId, accountId));
        queue = job.catch(() => undefined);
        const tracked = job.finally(() => inFlight.delete(accountId));
        inFlight.set(accountId, tracked);
        return tracked;
    }

    async function tick(): Promise<void> {
        ticking ??= (async () => {
            for (const { ownerId, id } of repos.mail.due(now())) await sync(ownerId, id);
        })().finally(() => {
            ticking = null;
        });
        return ticking;
    }

    async function test(ownerId: string, accountId: string): Promise<MailConnectionTest> {
        const account = repos.mail.get(ownerId, accountId);
        if (!account) throw new MailSyncError('The account was removed.');
        let pass: string;
        try {
            pass = password(account);
        } catch (error) {
            const check = { ok: false, error: message(error) };
            return { imap: check, smtp: check };
        }
        const login = { username: account.username, password: pass };
        try {
            const result = await runner({
                kind: 'test',
                imap: { server: account.imap, ...login },
                smtp: { server: account.smtp, ...login },
            });
            const clean = (c: { ok: boolean; error: string | null }) => ({
                ok: c.ok,
                error: c.error && message(c.error),
            });
            return { imap: clean(result.imap), smtp: clean(result.smtp) };
        } catch (error) {
            const check = { ok: false, error: message(error) };
            return { imap: check, smtp: check };
        }
    }

    return {
        runner,
        sync,
        test,
        tick,
        start() {
            if (timer) return;
            first = setTimeout(() => void tick(), FIRST_TICK_MS);
            first.unref?.();
            timer = setInterval(() => void tick(), MAIL_TICK_MS);
            timer.unref?.();
        },
        stop() {
            if (first) clearTimeout(first);
            if (timer) clearInterval(timer);
            timer = null;
            first = null;
        },
    };
}

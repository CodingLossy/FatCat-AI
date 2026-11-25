// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// QQ 凭据保存(ADR 0052 第 4 节):AppSecret 进 secrets.yaml,配置只记 AppID 与引用;删除渠道时只删这一行。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, SecretStore } from '@fatcat-ai/providers';
import { createRepositories, openStorage, type Repositories } from '@fatcat-ai/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QqAdapter } from '../qq.js';
import type { ChannelHub } from './hub.js';
import { QqChannels, qqSecretKey } from './qq-channels.js';

let dir: string;
let close: () => void;
let repos: Repositories;
let ownerId: string;
let redactor: Redactor;
let secrets: SecretStore;
const logs: string[] = [];

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fatcat-qq-'));
    const { conn } = await openStorage({ dataDir: dir });
    close = () => conn.close();
    repos = createRepositories(conn);
    ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    redactor = new Redactor();
    secrets = new SecretStore({ dataDir: dir, redactor, env: {} });
    logs.length = 0;
});

afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const make = () =>
    new QqChannels({
        repos,
        secrets,
        logger: {
            info: (fields, msg) => void logs.push(`${msg} ${JSON.stringify(fields)}`),
            warn: (fields, msg) => void logs.push(`${msg} ${JSON.stringify(fields)}`),
        },
        now: () => new Date('2026-11-25T00:00:00.000Z'),
    });

describe('QqChannels', () => {
    it('保存凭据:AppSecret 写进 secrets.yaml(先备份、其他行不变),配置记 AppID 与引用,然后重启渠道', async () => {
        writeFileSync(join(dir, 'secrets.yaml'), '# 注释\nOTHER_KEY: keep-me\n', { mode: 0o600 });
        const channel = repos.channels.create(ownerId, { kind: 'qq', label: 'QQ' });
        const restarted: string[] = [];
        const qq = make();
        qq.attach({ restart: (c: { id: string }) => void restarted.push(c.id) } as unknown as ChannelHub);
        await qq.saveCredentials(channel, { appId: '102030', appSecret: 'the-app-secret' });

        const file = readFileSync(join(dir, 'secrets.yaml'), 'utf8');
        expect(file).toBe(`# 注释\nOTHER_KEY: keep-me\n${qqSecretKey(channel.id)}: 'the-app-secret'\n`);
        expect(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('secrets-'))).toBe(true);
        expect(repos.channels.byId(channel.id)!.config).toEqual({
            appId: '102030',
            secretRef: `file:${qqSecretKey(channel.id)}`,
        });
        expect(restarted).toEqual([channel.id]);
        expect(redactor.redact('x the-app-secret y')).not.toContain('the-app-secret');
        expect(logs.join('\n')).not.toContain('the-app-secret');
        expect(qq.factory(repos.channels.byId(channel.id)!)).toBeInstanceOf(QqAdapter);

        qq.forget(channel.id);
        expect(readFileSync(join(dir, 'secrets.yaml'), 'utf8')).toBe('# 注释\nOTHER_KEY: keep-me\n');
    });

    it('secrets.yaml 解析失败时不写,文件字节不变,配置不变', async () => {
        const broken = 'this line has no colon\n';
        writeFileSync(join(dir, 'secrets.yaml'), broken, { mode: 0o600 });
        const channel = repos.channels.create(ownerId, { kind: 'qq', label: 'QQ' });
        await expect(
            make().saveCredentials(channel, { appId: '1', appSecret: 'the-app-secret' }),
        ).rejects.toMatchObject({
            status: 500,
            code: 'internal',
        });
        expect(readFileSync(join(dir, 'secrets.yaml'), 'utf8')).toBe(broken);
        expect(repos.channels.byId(channel.id)!.config).toEqual({});
        expect(logs.join('\n')).not.toContain('the-app-secret');
        // 删除时同样不动坏文件,只记日志
        make().forget(channel.id);
        expect(readFileSync(join(dir, 'secrets.yaml'), 'utf8')).toBe(broken);
    });
});

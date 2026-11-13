// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ADR 0026 测试清单:扫库(数据库所有列与加密文件里找不到明文密钥)与接口越权。只用临时目录和假密钥。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, SecretStore } from '@fatcat-ai/providers';
import { SecretsMigrateResponse, SecretsStatus } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirMasterKey } from './data-dir.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const MODEL_KEY = 'sk-test-FAKE-model-key-0123456789abcdef';
const MAIL_PW = 'fake-mail-app-password-77881';
const WECHAT_TOKEN = 'fake-ilink-token-5566778899aa';
const MASTER = 'cd'.repeat(32);

let s: TestServer;
afterEach(() => s?.cleanup());

async function setup() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const req = (path: string, init: RequestInit = {}, withCsrf = true) =>
        s.app.request(path, {
            ...init,
            headers: {
                cookie,
                'content-type': 'application/json',
                ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}),
                ...(init.headers as Record<string, string>),
            },
        });
    const post = (path: string, body: unknown, withCsrf = true) =>
        req(path, { method: 'POST', body: JSON.stringify(body) }, withCsrf);
    return { req, post, cookie };
}

/** 数据库里所有表的所有列(任何类型都转成文本)。 */
function dumpDatabase(): string {
    const tables = (
        s.conn.sqlite
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[]
    ).map((r) => r.name);
    const parts: string[] = [];
    for (const table of tables) {
        for (const row of s.conn.sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]) {
            for (const v of Object.values(row)) {
                parts.push(Buffer.isBuffer(v) ? v.toString('latin1') : String(v));
            }
        }
    }
    return parts.join('\n');
}

describe('secrets scan (ADR 0026)', () => {
    it('after migration the database, the encrypted file, its backups and the logs hold no plaintext key or token', async () => {
        const { post, req } = await setup();
        const secretsFile = join(s.dir, 'secrets.yaml');
        writeFileSync(secretsFile, `MODEL_KEY: '${MODEL_KEY}'\nMAIL_PW: "${MAIL_PW}"\n`, { mode: 0o600 });

        // 模型配置档、邮件账户、渠道、MCP 服务器:数据库里只存引用
        expect(
            (
                await post('/api/v1/models', {
                    label: 'DeepSeek',
                    kind: 'openai-compatible',
                    baseURL: 'http://fake.test/v1',
                    apiKeyRef: 'file:MODEL_KEY',
                    model: 'm',
                    purpose: ['chat'],
                })
            ).status,
        ).toBe(201);
        const mail = await post('/api/v1/mail/accounts', {
            label: 'Work',
            address: 'me@example.com',
            username: 'me@example.com',
            passwordRef: 'file:MAIL_PW',
            imap: { host: 'imap.example.com', port: 993, security: 'tls' },
            smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
        });
        expect(mail.status).toBe(201);
        expect((await post('/api/v1/channels', { kind: 'wechat', label: 'WeChat' })).status).toBe(201);
        expect(
            (
                await post('/api/v1/mcp/servers', {
                    name: 'scan',
                    command: process.execPath,
                    args: ['--version'],
                    enabled: false,
                })
            ).status,
        ).toBe(201);

        const migrate = await post('/api/v1/settings/secrets/migrate', { confirm: true });
        expect(migrate.status).toBe(200);
        const body = SecretsMigrateResponse.parse(await migrate.json());
        expect(body.migratedKeys).toBe(2);
        // 令牌像微信扫码那样经 SecretStore 写入:加密文件,不是 secrets.yaml
        const store = new SecretStore({
            dataDir: s.dir,
            redactor: new Redactor(),
            env: {},
            masterKey: dataDirMasterKey(s.dir, {}),
        });
        store.write('ILINK_TOKEN_01ARZ3NDEKTSV4RRFFQ69G5FAV', WECHAT_TOKEN);
        expect(existsSync(secretsFile)).toBe(false);

        const status = SecretsStatus.parse(await (await req('/api/v1/settings/secrets')).json());
        expect(status).toMatchObject({ file: 'encrypted', keyAvailable: true, masterKeySource: 'data-dir' });

        const secrets = [MODEL_KEY, MAIL_PW, WECHAT_TOKEN];
        const haystacks: Record<string, string> = { database: dumpDatabase(), logs: s.logs.join('\n') };
        haystacks.enc = readFileSync(join(s.dir, 'secrets.yaml.enc'), 'latin1');
        for (const f of readdirSync(join(s.dir, 'backups'))) {
            if (f.startsWith('secrets-')) haystacks[`backups/${f}`] = readFileSync(join(s.dir, 'backups', f), 'latin1');
        }
        // 迁移前的备份默认保留(keep):这是明文,不在扫描范围内;但主动选择 encrypt 的另有用例
        for (const [where, text] of Object.entries(haystacks)) {
            if (where.startsWith('backups/') && where.endsWith('.yaml')) continue;
            for (const secret of secrets) expect(text, `${where} leaks a secret`).not.toContain(secret);
            // 主密钥(文件内容)同样不应出现
            const masterKey = readFileSync(join(s.dir, 'master.key'), 'utf8').trim();
            expect(text, `${where} leaks the master key`).not.toContain(masterKey);
        }
        // 对照:被改名的明文文件确实含有密钥,说明扫描用的值是真的
        expect(readFileSync(join(s.dir, 'secrets.yaml.migrated'), 'utf8')).toContain(MODEL_KEY);
        expect(store.resolve('file:MODEL_KEY')).toBe(MODEL_KEY);
    });
});

describe('/api/v1/settings/secrets access control', () => {
    it('requires login (401) and a CSRF token for the migration', async () => {
        const { post } = await setup();
        const bare = await s.app.request('/api/v1/settings/secrets');
        expect(bare.status).toBe(401);
        const noLogin = await s.app.request('/api/v1/settings/secrets/migrate', jsonBody({ confirm: true }));
        expect(noLogin.status).toBe(401);
        const noCsrf = await post('/api/v1/settings/secrets/migrate', { confirm: true }, false);
        expect(noCsrf.status).toBe(403);
    });

    it('rejects a request without confirm: true and changes nothing', async () => {
        const { post } = await setup();
        const original = `MODEL_KEY: '${MODEL_KEY}'\n`;
        writeFileSync(join(s.dir, 'secrets.yaml'), original);
        for (const body of [{}, { confirm: false }, { confirm: 'true' }, { plaintextBackups: 'keep' }]) {
            const res = await post('/api/v1/settings/secrets/migrate', body);
            expect(res.status, JSON.stringify(body)).toBe(400);
        }
        expect(
            (await post('/api/v1/settings/secrets/migrate', { confirm: true, plaintextBackups: 'wipe' })).status,
        ).toBe(400);
        expect(readFileSync(join(s.dir, 'secrets.yaml'), 'utf8')).toBe(original);
        expect(existsSync(join(s.dir, 'secrets.yaml.enc'))).toBe(false);
    });

    it('reports the state without secret values, 409 when there is nothing to migrate or it is done already', async () => {
        const { post, req } = await setup();
        const fresh = SecretsStatus.parse(await (await req('/api/v1/settings/secrets')).json());
        expect(fresh).toEqual({
            file: 'none',
            masterKeySource: 'none',
            keyAvailable: true,
            fingerprint: null,
            backups: { total: 0, plaintext: 0 },
        });
        expect((await post('/api/v1/settings/secrets/migrate', { confirm: true })).status).toBe(409);

        writeFileSync(join(s.dir, 'secrets.yaml'), `MODEL_KEY: '${MODEL_KEY}'\n`);
        const plain = await req('/api/v1/settings/secrets');
        expect(SecretsStatus.parse(await plain.json())).toMatchObject({ file: 'plaintext' });

        const done = await post('/api/v1/settings/secrets/migrate', { confirm: true });
        const text = await done.text();
        expect(done.status).toBe(200);
        expect(text).not.toContain(MODEL_KEY);
        expect(text).not.toContain(readFileSync(join(s.dir, 'master.key'), 'utf8').trim());
        const after = await (await req('/api/v1/settings/secrets')).text();
        expect(after).not.toContain(MODEL_KEY);
        expect(JSON.parse(after).fingerprint).toMatch(/^[0-9a-f]{8}$/);
        expect((await post('/api/v1/settings/secrets/migrate', { confirm: true })).status).toBe(409);
        expect(s.logs.join('\n')).not.toContain(MODEL_KEY);
    });

    it('a missing master key leaves the server up, reports keyAvailable false, and changes no file', async () => {
        const { post, req } = await setup();
        writeFileSync(join(s.dir, 'secrets.yaml'), `MODEL_KEY: '${MODEL_KEY}'\n`);
        expect((await post('/api/v1/settings/secrets/migrate', { confirm: true })).status).toBe(200);
        const enc = readFileSync(join(s.dir, 'secrets.yaml.enc'));
        writeFileSync(join(s.dir, 'master.key'), `${MASTER}\n`); // 换成另一把
        const status = SecretsStatus.parse(await (await req('/api/v1/settings/secrets')).json());
        expect(status).toMatchObject({ file: 'encrypted', keyAvailable: false });
        expect(readFileSync(join(s.dir, 'secrets.yaml.enc')).equals(enc)).toBe(true);
    });
});

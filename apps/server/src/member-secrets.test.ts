// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 成员的密钥与共享配置档(ADR 0053 第 5 节):成员的键带自己的前缀,引用在保存时检查和换算,
// env: 只给管理员;管理员可以把配置档共享给成员,成员只能用、看不到地址和密钥引用、也改不了。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoginResponse, SecretKeyList } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findUnusableRefs } from './member-secrets.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
type Session = { cookie: string; csrf: string };
let admin: Session;

beforeEach(async () => {
    s = await createTestServer();
    admin = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
});
afterEach(async () => {
    await s.cleanup();
});

const as = (who: Session, method: string, path: string, body?: unknown) =>
    s.app.request(path, {
        method,
        headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
};
const member = async (username = 'kid') => {
    const { code } = await json<{ code: string }>(await as(admin, 'POST', '/api/v1/admin/users/invites'), 201);
    const res = await s.app.request(
        '/api/v1/auth/invite/accept',
        jsonBody({ code, username, password: TEST_PASSWORD }),
    );
    expect(res.status).toBe(201);
    return { id: LoginResponse.parse(await res.json()).owner.id, session: sessionFrom(res) as Session };
};
const keys = async (who: Session) =>
    SecretKeyList.parse(await json(await as(who, 'GET', '/api/v1/settings/secret-keys'), 200)).items;
const profile = (over: Record<string, unknown> = {}) => ({
    label: 'Chat',
    kind: 'openai-compatible',
    baseURL: 'https://llm.example.test/v1',
    apiKeyRef: 'file:OPENAI_KEY',
    model: 'm1',
    purpose: ['chat'],
    ...over,
});

describe('member secrets (ADR 0053 section 5)', () => {
    it('成员保存的键带自己的前缀,各看各的;渠道的键和保留名不能写', async () => {
        const kid = await member();
        const saved = await json<{ name: string; ref: string }>(
            await as(kid.session, 'PUT', '/api/v1/settings/secret-keys/OPENAI_KEY', { value: 'sk-kid-123456' }),
            200,
        );
        expect(saved).toEqual({ name: 'OPENAI_KEY', ref: `file:U${kid.id}_OPENAI_KEY` });
        await json(await as(admin, 'PUT', '/api/v1/settings/secret-keys/OPENAI_KEY', { value: 'sk-admin-1234' }), 200);
        s.secrets.write('ILINK_TOKEN_abc', 'channel-token');

        expect(await keys(kid.session)).toEqual([saved]);
        expect(await keys(admin)).toEqual([{ name: 'OPENAI_KEY', ref: 'file:OPENAI_KEY' }]);
        expect(s.secrets.resolve(`file:U${kid.id}_OPENAI_KEY`)).toBe('sk-kid-123456');
        expect(s.secrets.resolve('file:OPENAI_KEY')).toBe('sk-admin-1234');

        for (const name of ['ILINK_TOKEN_abc', `U${kid.id}_X`, '1BAD']) {
            expect((await as(kid.session, 'PUT', `/api/v1/settings/secret-keys/${name}`, { value: 'v' })).status).toBe(
                400,
            );
            expect((await as(admin, 'DELETE', `/api/v1/settings/secret-keys/${name}`)).status).toBe(400);
        }
        expect((await as(kid.session, 'PUT', '/api/v1/settings/secret-keys/A', { value: 'a\nb' })).status).toBe(400);
        // 加上前缀超过 64 个字符
        expect(
            (await as(kid.session, 'PUT', `/api/v1/settings/secret-keys/${'A'.repeat(40)}`, { value: 'v' })).status,
        ).toBe(400);

        // 删除只删自己的
        expect((await as(kid.session, 'DELETE', '/api/v1/settings/secret-keys/OPENAI_KEY')).status).toBe(204);
        expect((await as(kid.session, 'DELETE', '/api/v1/settings/secret-keys/OPENAI_KEY')).status).toBe(404);
        expect(await keys(kid.session)).toEqual([]);
        expect(s.secrets.resolve('file:OPENAI_KEY')).toBe('sk-admin-1234');
        expect(s.secrets.resolve('file:ILINK_TOKEN_abc')).toBe('channel-token');
    });

    it('跨账户:成员删不到管理员的键,碰不到别的成员的键;管理员也碰不到成员的键;列表里没有值和成员 id', async () => {
        const kid = await member();
        const sib = await member('sib');
        await json(await as(admin, 'PUT', '/api/v1/settings/secret-keys/OPENAI_KEY', { value: 'sk-admin-1234' }), 200);
        await json(await as(sib.session, 'PUT', '/api/v1/settings/secret-keys/B', { value: 'sib-value-1' }), 200);
        await json(await as(kid.session, 'PUT', '/api/v1/settings/secret-keys/B', { value: 'kid-value-1' }), 200);

        // 成员删管理员才有的键名:按自己的前缀找,找不到
        expect((await as(kid.session, 'DELETE', '/api/v1/settings/secret-keys/OPENAI_KEY')).status).toBe(404);
        expect(s.secrets.resolve('file:OPENAI_KEY')).toBe('sk-admin-1234');

        // 成员写或删别的成员前缀的名字:保留名,400
        const sibKey = `U${sib.id}_B`;
        expect((await as(kid.session, 'PUT', `/api/v1/settings/secret-keys/${sibKey}`, { value: 'x' })).status).toBe(
            400,
        );
        expect((await as(kid.session, 'DELETE', `/api/v1/settings/secret-keys/${sibKey}`)).status).toBe(400);
        expect(s.secrets.resolve(`file:${sibKey}`)).toBe('sib-value-1');

        // 管理员删成员的键:同样 400
        const kidKey = `U${kid.id}_B`;
        expect((await as(admin, 'DELETE', `/api/v1/settings/secret-keys/${kidKey}`)).status).toBe(400);
        expect(s.secrets.resolve(`file:${kidKey}`)).toBe('kid-value-1');

        // 管理员的列表:没有值,也没有任何成员 id
        const raw = await (await as(admin, 'GET', '/api/v1/settings/secret-keys')).text();
        for (const hidden of ['sk-admin-1234', 'sib-value-1', 'kid-value-1', kid.id, sib.id]) {
            expect(raw).not.toContain(hidden);
        }
        expect(JSON.parse(raw)).toEqual({ items: [{ name: 'OPENAI_KEY', ref: 'file:OPENAI_KEY' }] });
    });

    it('引用在保存时换算:成员的 file: 加前缀,env: 和别人的键被拒;管理员原样', async () => {
        const kid = await member();
        const other = await member('sib');
        const created = await json<{ id: string; apiKeyRef: string }>(
            await as(kid.session, 'POST', '/api/v1/models', profile()),
            201,
        );
        expect(created.apiKeyRef).toBe(`file:U${kid.id}_OPENAI_KEY`);
        // 读回来的值原样 PATCH 回去不会再加一层前缀
        const same = await json<{ apiKeyRef: string }>(
            await as(kid.session, 'PATCH', `/api/v1/models/${created.id}`, { apiKeyRef: created.apiKeyRef }),
            200,
        );
        expect(same.apiKeyRef).toBe(created.apiKeyRef);

        const env = await json<{ code: string }>(
            await as(kid.session, 'POST', '/api/v1/models', profile({ apiKeyRef: 'env:OPENAI_KEY' })),
            403,
        );
        expect(env.code).toBe('admin_required');
        for (const ref of [`file:U${other.id}_OPENAI_KEY`, 'file:QQBOT_SECRET_x']) {
            expect((await as(kid.session, 'POST', '/api/v1/models', profile({ apiKeyRef: ref }))).status).toBe(400);
        }
        // 管理员也不能引用成员的键;env: 和不带前缀的 file: 原样
        expect(
            (await as(admin, 'POST', '/api/v1/models', profile({ apiKeyRef: `file:U${kid.id}_OPENAI_KEY` }))).status,
        ).toBe(400);
        const mine = await json<{ apiKeyRef: string }>(
            await as(admin, 'POST', '/api/v1/models', profile({ apiKeyRef: 'env:OPENAI_KEY' })),
            201,
        );
        expect(mine.apiKeyRef).toBe('env:OPENAI_KEY');

        // 邮箱密码一样
        const mail = {
            label: 'Mail',
            address: 'kid@example.test',
            username: 'kid@example.test',
            imap: { host: 'imap.example.test', port: 993, security: 'tls' },
            smtp: { host: 'smtp.example.test', port: 465, security: 'tls' },
        };
        const account = await json<{ id: string; passwordRef: string }>(
            await as(kid.session, 'POST', '/api/v1/mail/accounts', { ...mail, passwordRef: 'file:MAIL_PW' }),
            201,
        );
        expect(account.passwordRef).toBe(`file:U${kid.id}_MAIL_PW`);
        expect(
            (await as(kid.session, 'PATCH', `/api/v1/mail/accounts/${account.id}`, { passwordRef: 'env:MAIL_PW' }))
                .status,
        ).toBe(403);
        expect(
            (await as(kid.session, 'POST', '/api/v1/mail/accounts', { ...mail, passwordRef: 'env:MAIL_PW' })).status,
        ).toBe(403);
    });

    it('共享配置档:只有管理员能共享;成员看到只读的一项,能选来用,不能改、删、测', async () => {
        const kid = await member();
        expect((await as(kid.session, 'POST', '/api/v1/models', profile({ shared: true }))).status).toBe(403);
        const shared = await json<{ id: string; shared: boolean }>(
            await as(admin, 'POST', '/api/v1/models', profile({ shared: true, label: 'Family' })),
            201,
        );
        expect(shared.shared).toBe(true);
        const hidden = await json<{ id: string }>(await as(admin, 'POST', '/api/v1/models', profile()), 201);

        const list = await json<{ items: Record<string, unknown>[] }>(
            await as(kid.session, 'GET', '/api/v1/models'),
            200,
        );
        expect(list.items).toHaveLength(1);
        const item = list.items[0]!;
        expect(item).toMatchObject({ id: shared.id, label: 'Family', model: 'm1', readOnly: true, apiKeyRef: null });
        expect(item).not.toHaveProperty('baseURL');
        expect((await as(kid.session, 'GET', `/api/v1/models/${hidden.id}`)).status).toBe(404);

        expect((await as(kid.session, 'PATCH', `/api/v1/models/${shared.id}`, { label: 'x' })).status).toBe(404);
        expect((await as(kid.session, 'DELETE', `/api/v1/models/${shared.id}`)).status).toBe(404);
        expect((await as(kid.session, 'POST', `/api/v1/models/${shared.id}/test`)).status).toBe(404);

        // 能设为默认、能建会话
        expect((await as(kid.session, 'PUT', '/api/v1/settings', { defaultChatProfileId: shared.id })).status).toBe(
            200,
        );
        expect((await as(kid.session, 'PUT', '/api/v1/settings', { defaultChatProfileId: hidden.id })).status).toBe(
            400,
        );
        expect(
            (await as(kid.session, 'POST', '/api/v1/sessions', { title: 't', modelProfileId: shared.id })).status,
        ).toBe(201);

        // 管理员降为成员后,共享立即失效
        const second = s.repos.owners.create({ username: 'second', passwordHash: 'x', role: 'admin' });
        expect(second.role).toBe('admin');
        expect(s.repos.accounts.setRole(s.repos.owners.primaryAdmin()!, 'member')).toBe('ok');
        expect((await json<{ items: unknown[] }>(await as(kid.session, 'GET', '/api/v1/models'), 200)).items).toEqual(
            [],
        );
    });

    it('删除账户时,加密的 secrets.yaml.enc 里这个账户的行也被删掉,其他行不变', async () => {
        const kid = await member();
        await json(await as(kid.session, 'PUT', '/api/v1/settings/secret-keys/OPENAI_KEY', { value: 'sk-kid-1' }), 200);
        await json(await as(admin, 'PUT', '/api/v1/settings/secret-keys/KEEP', { value: 'keep-me-1' }), 200);
        expect(existsSync(join(s.dir, 'secrets.yaml.enc'))).toBe(true);
        expect(existsSync(join(s.dir, 'secrets.yaml'))).toBe(false);
        expect(readFileSync(join(s.dir, 'secrets.yaml.enc'), 'utf8')).not.toContain('sk-kid-1');

        expect((await as(admin, 'DELETE', `/api/v1/admin/users/${kid.id}`, { confirmUsername: 'kid' })).status).toBe(
            204,
        );
        s.secrets.invalidate();
        expect(s.secrets.keyNames()).toEqual(['KEEP']);
        expect(s.secrets.resolve('file:KEEP')).toBe('keep-me-1');
    });

    it('管理员降为成员后,他以前保存的不带前缀的引用显示为缺失、也解析不出来;再升回管理员就恢复(库里的引用不改)', async () => {
        s.secrets.write('OPENAI_KEY', 'sk-admin-1234');
        s.secrets.write('MAIL_PW', 'mail-pw-1234');
        const created = await json<{ id: string; keyStatus: string }>(
            await as(admin, 'POST', '/api/v1/models', profile()),
            201,
        );
        expect(created.keyStatus).toBe('present');
        const mail = await json<{ id: string; passwordStatus: string }>(
            await as(admin, 'POST', '/api/v1/mail/accounts', {
                label: 'Mail',
                address: 'me@example.test',
                username: 'me@example.test',
                imap: { host: 'imap.example.test', port: 993, security: 'tls' },
                smtp: { host: 'smtp.example.test', port: 465, security: 'tls' },
                passwordRef: 'file:MAIL_PW',
            }),
            201,
        );
        expect(mail.passwordStatus).toBe('present');

        const kid = await member();
        await json(await as(admin, 'PATCH', `/api/v1/admin/users/${kid.id}`, { role: 'admin' }), 200);
        const ownerId = s.repos.owners.getByUsername('owner')!.id;
        await json(await as(kid.session, 'PATCH', `/api/v1/admin/users/${ownerId}`, { role: 'member' }), 200);

        const status = async () => ({
            key: (await json<{ keyStatus: string }>(await as(admin, 'GET', `/api/v1/models/${created.id}`), 200))
                .keyStatus,
            mail: (
                await json<{ passwordStatus: string }>(await as(admin, 'GET', `/api/v1/mail/accounts/${mail.id}`), 200)
            ).passwordStatus,
        });
        expect(await status()).toEqual({ key: 'missing', mail: 'missing' });
        // 对话也拿不到这个键:开会话发消息回 409 model_key_missing
        const session = await json<{ id: string }>(await as(admin, 'POST', '/api/v1/sessions', {}), 201);
        const sent = await as(admin, 'POST', `/api/v1/sessions/${session.id}/messages?stream=false`, { text: 'hi' });
        expect(sent.status).toBe(409);
        expect(((await sent.json()) as { code: string }).code).toBe('model_key_missing');
        expect(s.repos.modelProfiles.get(ownerId, created.id)?.apiKeyRef).toBe('file:OPENAI_KEY');

        // 启动时的提示只列 id
        expect(findUnusableRefs(s.repos)).toEqual([{ ownerId, profiles: [created.id], mailAccounts: [mail.id] }]);

        await json(await as(kid.session, 'PATCH', `/api/v1/admin/users/${ownerId}`, { role: 'admin' }), 200);
        expect(await status()).toEqual({ key: 'present', mail: 'present' });
        expect(findUnusableRefs(s.repos)).toEqual([]);
    });
});

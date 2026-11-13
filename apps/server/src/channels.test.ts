// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道接口与运行器(ADR 0022 第 4、7、8、11 节):越权、指令、排队、退避、降级提醒、日志不含正文与外部账号。
import { FakeChannelAdapter, type FakeAdapterOptions } from '@fatcat-ai/channels/testing';
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { Channel, ChannelPairing, ChannelStatus, MetaResponseSchema, pageOf } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalReminder, composeUserText, IGNORED_MESSAGES_PER_MINUTE, MAX_QUEUE, REPLIES } from './channels/hub.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

type Step = (request: ChatRequest) => AsyncGenerator<ChatChunk>;
const say = (text: string): Step =>
    async function* () {
        yield { type: 'text-delta', delta: text };
        yield { type: 'finish', reason: 'stop' };
    };
const fail = (): Step =>
    // eslint-disable-next-line require-yield
    async function* () {
        throw new Error('boom');
    };
const write = (text: string): Step =>
    async function* () {
        yield { type: 'tool-call', callId: 'w1', name: 'memory.write', input: { text } };
        yield { type: 'finish', reason: 'tool-calls' };
    };

const OWNER = 'wx-owner-0001';
const SECRET_TEXT = '我的银行卡密码是 314159';

async function setup(options: { adapters?: boolean; model?: boolean; fake?: FakeAdapterOptions } = {}) {
    const steps: Step[] = [];
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: (request) => {
            const next = steps.shift();
            if (!next) throw new Error('no scripted step');
            return next(request);
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    const fakes = new Map<string, FakeChannelAdapter>();
    s = await createTestServer(
        {},
        {
            provider,
            ...(options.adapters === false
                ? {}
                : {
                      channelAdapters: {
                          wechat: (channel) => {
                              // 重启时适配器重新创建:failStarts 只对第一个生效
                              const fake = new FakeChannelAdapter(
                                  fakes.has(channel.id) ? { ...options.fake, failStarts: 0 } : options.fake,
                              );
                              fakes.set(channel.id, fake);
                              return fake;
                          },
                      },
                  }),
        },
    );
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) => s.app.request(path, { headers, ...init });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    const patch = (path: string, body: unknown) => req(path, { method: 'PATCH', body: JSON.stringify(body) });
    if (options.model !== false) {
        await post('/api/v1/models', {
            label: 'fake',
            kind: 'openai-compatible',
            baseURL: 'http://fake.test/v1',
            apiKeyRef: null,
            model: 'm',
            purpose: ['chat'],
        });
    }
    const ownerId = s.repos.owners.ids()[0]!;
    const create = async (label = '微信') =>
        Channel.parse(await (await post('/api/v1/channels', { kind: 'wechat', label })).json());
    const status = async (id: string) => ChannelStatus.parse(await (await req(`/api/v1/channels/${id}/status`)).json());
    /** 新建、启用并绑定。 */
    async function bound() {
        const channel = await create();
        await patch(`/api/v1/channels/${channel.id}`, { enabled: true });
        const fake = fakes.get(channel.id)!;
        const { code } = ChannelPairing.parse(await (await post(`/api/v1/channels/${channel.id}/pairing`)).json());
        await fake.deliver({ externalUserId: OWNER, text: `绑定 ${code}` });
        const last = () => fake.textsTo(OWNER).at(-1) ?? '';
        return { channel, fake, last, idle: () => s.channels.idle(channel.id) };
    }
    return { steps, req, post, patch, create, status, bound, fakes, ownerId };
}

describe('渠道接口', () => {
    it('新建默认停用;列表与详情不含密钥引用;外部账号打码;已绑定时不能再生成配对码', async () => {
        const t = await setup();
        const channel = await t.create();
        expect(channel).toMatchObject({ kind: 'wechat', label: '微信', enabled: false, binding: null });
        expect((await t.status(channel.id)).state).toBe('stopped');
        const { fake, channel: b } = await t.bound();
        expect(fake.textsTo(OWNER)).toEqual([REPLIES.bound]);
        const list = pageOf(Channel).parse(await (await t.req('/api/v1/channels')).json());
        expect(list.items).toHaveLength(2);
        const raw = JSON.stringify(list);
        expect(raw).not.toContain(OWNER);
        expect(raw).not.toContain('config');
        const detail = Channel.parse(await (await t.req(`/api/v1/channels/${b.id}`)).json());
        expect(detail.binding?.maskedExternalUserId).toBe('****0001');
        expect((await t.post(`/api/v1/channels/${b.id}/pairing`)).status).toBe(409);
        expect((await t.patch(`/api/v1/channels/${b.id}`, {})).status).toBe(400);
        expect((await t.patch(`/api/v1/channels/${b.id}`, { label: '工作微信' })).status).toBe(200);

        const meta = MetaResponseSchema.parse(await (await t.req('/api/v1/meta')).json());
        expect(meta.capabilities).toContain('channels');

        expect((await t.req(`/api/v1/channels/${b.id}`, { method: 'DELETE' })).status).toBe(204);
        expect(fake.stops).toBe(1);
        expect((await t.req(`/api/v1/channels/${b.id}`)).status).toBe(404);
    });

    it('越权:别人的渠道一律 404;未登录 401', async () => {
        const t = await setup();
        const channel = await t.create();
        // 1.0 只有一个主人账户:把这一行改到另一个 owner 名下,模拟别人的渠道
        s.conn.sqlite.pragma('foreign_keys = OFF');
        s.conn.sqlite.prepare('UPDATE channels SET owner_id = ? WHERE id = ?').run('someone-else', channel.id);
        s.conn.sqlite.pragma('foreign_keys = ON');
        const base = `/api/v1/channels/${channel.id}`;
        expect((await t.req(base)).status).toBe(404);
        expect((await t.patch(base, { enabled: true })).status).toBe(404);
        expect((await t.post(`${base}/pairing`)).status).toBe(404);
        expect((await t.req(`${base}/binding`, { method: 'DELETE' })).status).toBe(404);
        expect((await t.req(`${base}/status`)).status).toBe(404);
        expect((await t.req(base, { method: 'DELETE' })).status).toBe(404);
        expect(s.repos.channels.byId(channel.id)).not.toBeNull();
        expect(pageOf(Channel).parse(await (await t.req('/api/v1/channels')).json()).items).toEqual([]);

        expect((await s.app.request('/api/v1/channels')).status).toBe(401);
        expect((await s.app.request(`${base}/status`)).status).toBe(401);
        const anon = await s.app.request('/api/v1/channels', jsonBody({ kind: 'wechat', label: 'x' }));
        expect(anon.status).toBe(401);
    });

    it('没有注册适配器的类型:启用后状态为 error(adapter_unavailable)', async () => {
        const t = await setup({ adapters: false });
        const channel = await t.create();
        await t.patch(`/api/v1/channels/${channel.id}`, { enabled: true });
        const status = await t.status(channel.id);
        expect(status.state).toBe('error');
        expect(status.lastError?.code).toBe('adapter_unavailable');
        await t.patch(`/api/v1/channels/${channel.id}`, { enabled: false });
        expect((await t.status(channel.id)).state).toBe('stopped');
    });
});

describe('渠道运行器', () => {
    it('/new /source /help;空消息提示只能看文字;语音用平台的文字结果', async () => {
        const t = await setup();
        const c = await t.bound();
        await c.fake.deliver({ externalUserId: OWNER, text: '/help' });
        expect(c.last()).toBe(REPLIES.help);
        await c.fake.deliver({ externalUserId: OWNER, text: '/source' });
        expect(c.last()).toBe('https://github.com/CodingLossy/FatCat-AI');
        await c.fake.deliver({ externalUserId: OWNER, text: '' });
        expect(c.last()).toBe(REPLIES.textOnly);
        await c.fake.deliver({ externalUserId: OWNER, text: `绑定 123456` });
        expect(c.last()).toBe(REPLIES.alreadyBound);

        t.steps.push(say('**你好**,[文档](https://example.com)'));
        await c.fake.deliver({ externalUserId: OWNER, text: '', voice: { transcript: '你好' } });
        await c.idle();
        expect(c.last()).toBe('你好,文档 (https://example.com)');
        const first = s.repos.channels.byId(c.channel.id)!.sessionId;
        expect(s.repos.sessions.get(t.ownerId, first!)?.title).toBe('微信');

        await c.fake.deliver({ externalUserId: OWNER, text: '/new' });
        expect(c.last()).toBe(REPLIES.newSession);
        expect(s.repos.channels.byId(c.channel.id)!.sessionId).not.toBe(first);
        expect(REPLIES.help).toContain('/clear');
        expect(REPLIES.help).toContain('清空');
    });

    it('/clear 与「清空」只删除该渠道的当前会话,并停掉进行中的运行;记忆和其他对话还在', async () => {
        const t = await setup();
        const c = await t.bound();
        const kept = s.repos.sessions.create(t.ownerId, { title: '网页上的对话' });
        expect(
            (await t.post('/api/v1/memory', { text: '下周三提交周报', memType: 'episodic', subtype: 'task' })).status,
        ).toBe(200);

        let aborted = false;
        let providerStarted = false;
        t.steps.push(async function* (request) {
            providerStarted = true;
            await new Promise<void>((resolve) => {
                const finish = () => {
                    aborted = true;
                    resolve();
                };
                if (request.signal?.aborted) return finish();
                request.signal?.addEventListener('abort', finish);
            });
            yield { type: 'finish', reason: 'aborted' };
        });
        await c.fake.deliver({ externalUserId: OWNER, text: '先说一句' });
        await vi.waitFor(() => expect(s.repos.channels.byId(c.channel.id)?.sessionId).toBeTruthy());
        const channelSession = s.repos.channels.byId(c.channel.id)!.sessionId!;
        await vi.waitFor(() => expect(providerStarted).toBe(true));

        await c.fake.deliver({ externalUserId: 'stranger-1', text: '/clear' });
        expect(c.fake.textsTo('stranger-1')).toEqual([]);
        expect(s.repos.sessions.get(t.ownerId, channelSession)).not.toBeNull();

        await c.fake.deliver({ externalUserId: OWNER, text: '清空' });
        await vi.waitFor(() => expect(c.last()).toBe(REPLIES.cleared));
        expect(aborted).toBe(true);
        expect(s.repos.sessions.get(t.ownerId, channelSession)).toBeNull();
        expect(s.repos.channels.byId(c.channel.id)?.sessionId).toBeNull();
        expect(s.repos.sessions.get(t.ownerId, kept.id)?.title).toBe('网页上的对话');
        expect(s.repos.sessions.delete('someone-else', kept.id)).toBe(false);
        expect(s.repos.memories.list(t.ownerId, 10).map((m) => m.text)).toContain('下周三提交周报');
        expect(c.fake.textsTo(OWNER).some((text) => text.includes('先说一句'))).toBe(false);
    });

    it('/clear 之后马上再发一条消息:消息落在新会话里并收到回答,旧会话已删除', async () => {
        const t = await setup();
        const c = await t.bound();
        t.steps.push(say('旧回答'));
        await c.fake.deliver({ externalUserId: OWNER, text: '先建会话' });
        await c.idle();
        const oldSession = s.repos.channels.byId(c.channel.id)!.sessionId!;

        t.steps.push(say('新回答'));
        await c.fake.deliver({ externalUserId: OWNER, text: '/clear' });
        await c.fake.deliver({ externalUserId: OWNER, text: '清空后的第一条' });
        await c.idle();

        const newSession = s.repos.channels.byId(c.channel.id)!.sessionId!;
        expect(newSession).not.toBe(oldSession);
        expect(s.repos.sessions.get(t.ownerId, oldSession)).toBeNull();
        expect(s.repos.sessions.get(t.ownerId, newSession)).not.toBeNull();
        expect(c.fake.textsTo(OWNER).slice(-2)).toEqual([REPLIES.cleared, '新回答']);
    });

    it('同一会话正在运行时排队(最多 5 条),多出的回复「上一条还没处理完」;处理完按顺序回答', async () => {
        const t = await setup();
        const c = await t.bound();
        t.steps.push(write('我妈妈的生日是 5 月 3 日'), say('第 0 条'));
        await c.fake.deliver({ externalUserId: OWNER, text: '记住我妈妈的生日' });
        await vi.waitFor(() => expect(c.last()).toMatch(/^需要确认/));
        const code = /确认 ([A-Z]\d)/.exec(c.last())![1]!;
        for (let i = 1; i <= MAX_QUEUE + 1; i++) await c.fake.deliver({ externalUserId: OWNER, text: `第 ${i} 条` });
        expect(c.last()).toBe(REPLIES.busy);
        for (let i = 1; i <= MAX_QUEUE; i++) t.steps.push(say(`回答 ${i}`));
        await c.fake.deliver({ externalUserId: OWNER, text: `拒绝 ${code}` });
        await c.idle();
        const answers = c.fake.textsTo(OWNER).filter((x) => x.startsWith('回答') || x === '第 0 条');
        expect(answers).toEqual(['第 0 条', '回答 1', '回答 2', '回答 3', '回答 4', '回答 5']);
    });

    it('Web 正在同一会话里跑时等它结束;模型出错与没有模型配置档时给出提示;长回答切段', async () => {
        const t = await setup({ fake: { capabilities: { maxTextBytes: 200 } } });
        const c = await t.bound();
        t.steps.push(say('先建会话'));
        await c.fake.deliver({ externalUserId: OWNER, text: '你好' });
        await c.idle();
        const sessionId = s.repos.channels.byId(c.channel.id)!.sessionId!;

        // Web 在同一会话里等审批时,IM 的消息等它结束再开始
        t.steps.push(write('我妈妈的生日是 5 月 3 日'), say('Web 的回答'), say('IM 的回答'));
        await t.post(`/api/v1/sessions/${sessionId}/messages?stream=false`, { text: '记住我妈妈的生日' });
        await vi.waitFor(() => expect(c.last()).toMatch(/^需要确认/));
        await c.fake.deliver({ externalUserId: OWNER, text: '再问一句' });
        const callId = s.repos.approvals.list(t.ownerId, { status: 'pending', limit: 5 }).items[0]!.callId;
        await t.post(`/api/v1/approvals/${callId}`, { decision: 'reject' });
        await c.idle();
        expect(c.last()).toBe('IM 的回答');

        t.steps.push(fail());
        await c.fake.deliver({ externalUserId: OWNER, text: '会失败' });
        await c.idle();
        expect(c.last()).toBe(REPLIES.failed);

        t.steps.push(say('长'.repeat(100)));
        await c.fake.deliver({ externalUserId: OWNER, text: '说长一点' });
        await c.idle();
        const parts = c.fake.textsTo(OWNER).slice(-2);
        expect(parts[0]).toMatch(/\(1\/2\)$/);
        expect(parts.at(-1)).toMatch(/\(\d\/\d\)$/);
        parts.forEach((p) => expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(200));

        s.conn.sqlite.prepare('DELETE FROM model_profiles').run();
        await c.fake.deliver({ externalUserId: OWNER, text: '没有模型了' });
        await c.idle();
        expect(c.last()).toBe(REPLIES.noModel);
    });

    it('适配器启动失败时按退避重启;needs-login 不重试;report(error) 也会重启', async () => {
        const t = await setup({ fake: { failStarts: 1 } });
        const channel = await t.create();
        await t.patch(`/api/v1/channels/${channel.id}`, { enabled: true });
        const status = await t.status(channel.id);
        expect(status.state).toBe('backoff');
        expect(status.lastError?.code).toBe('start_failed');
        expect(status.retryAt).not.toBeNull();
        await vi.waitFor(async () => expect((await t.status(channel.id)).state).toBe('running'), { timeout: 3000 });

        const fake = t.fakes.get(channel.id)!;
        fake.ctx!.report('needs-login', { code: 'token_expired', message: 'Scan the QR code again.' });
        expect(await t.status(channel.id)).toMatchObject({
            state: 'needs-login',
            lastError: { code: 'token_expired' },
        });
        fake.ctx!.report('running');
        expect((await t.status(channel.id)).state).toBe('running');
        fake.ctx!.report('error', { code: 'poll_failed', message: 'Long polling failed.' });
        expect((await t.status(channel.id)).state).toBe('backoff');
        await t.patch(`/api/v1/channels/${channel.id}`, { enabled: false });
        expect(await t.status(channel.id)).toMatchObject({ state: 'stopped', retryAt: null });
    });

    it('降级提醒:打开后 10 分钟内 3 次降级提醒一次,恢复正常后才会再提醒', async () => {
        const t = await setup();
        const c = await t.bound();
        await t.patch(`/api/v1/channels/${c.channel.id}`, { notifyDegraded: true });
        t.steps.push(say('建会话'));
        await c.fake.deliver({ externalUserId: OWNER, text: '你好' });
        await c.idle();
        const sessionId = s.repos.channels.byId(c.channel.id)!.sessionId!;
        const publish = (runId: string, event: object) =>
            s.bus.publish(t.ownerId, { seq: 1, at: new Date().toISOString(), sessionId, event: event as never }, runId);
        const degraded = (runId: string) =>
            publish(runId, {
                type: 'memory-used',
                runId,
                ids: [],
                degraded: [{ path: 'vec', reason: 'timeout' }],
            });
        const finished = (runId: string) => publish(runId, { type: 'run-finished', runId, reason: 'stop' });
        const notices = () => c.fake.textsTo(OWNER).filter((x) => x === REPLIES.degraded).length;
        for (const id of ['r1', 'r2', 'r3', 'r4']) {
            degraded(id);
            finished(id);
        }
        await vi.waitFor(() => expect(notices()).toBe(1));
        finished('r5'); // 一轮没有降级:恢复正常
        for (const id of ['r6', 'r7', 'r8']) degraded(id);
        await vi.waitFor(() => expect(notices()).toBe(2));
    });

    it('被忽略的消息超过每分钟上限后只计数不落库;过期的配对码不计失败;一轮中解除绑定则不发回答', async () => {
        const t = await setup();
        const channel = await t.create();
        await t.patch(`/api/v1/channels/${channel.id}`, { enabled: true });
        const fake = t.fakes.get(channel.id)!;
        for (let i = 0; i < IGNORED_MESSAGES_PER_MINUTE + 5; i++) {
            await fake.deliver({ externalUserId: 'stranger', text: `hi ${i}` });
        }
        const rows = s.conn.sqlite.prepare('SELECT COUNT(*) AS n FROM channel_inbox').get() as { n: number };
        expect(rows.n).toBe(IGNORED_MESSAGES_PER_MINUTE);
        expect((await t.status(channel.id)).ignoredCount).toBe(IGNORED_MESSAGES_PER_MINUTE + 5);

        await t.post(`/api/v1/channels/${channel.id}/pairing`);
        s.conn.sqlite.prepare('UPDATE channel_pairings SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
        await fake.deliver({ externalUserId: OWNER, text: '绑定 123456' });
        expect(fake.textsTo(OWNER)).toEqual([]);
        expect(s.repos.channels.getPairing(channel.id)?.failedAttempts).toBe(0);

        const { code } = ChannelPairing.parse(await (await t.post(`/api/v1/channels/${channel.id}/pairing`)).json());
        await fake.deliver({ externalUserId: OWNER, text: `绑定 ${code}` });
        t.steps.push(write('我妈妈的生日是 5 月 3 日'), say('不该发出的回答'));
        await fake.deliver({ externalUserId: OWNER, text: '记住我妈妈的生日' });
        await vi.waitFor(() => expect(fake.textsTo(OWNER).at(-1)).toMatch(/^需要确认/));
        const callId = s.repos.approvals.list(t.ownerId, { status: 'pending', limit: 5 }).items[0]!.callId;
        await t.req(`/api/v1/channels/${channel.id}/binding`, { method: 'DELETE' });
        await t.post(`/api/v1/approvals/${callId}`, { decision: 'reject' });
        await s.channels.idle(channel.id);
        await s.runs.idle();
        expect(fake.textsTo(OWNER)).not.toContain('不该发出的回答');
    });

    it('不可信内容的组装;每日清理 3 天前的去重记录;日志不含正文与外部账号', async () => {
        expect(
            composeUserText({
                externalMessageId: 'x',
                externalUserId: 'u',
                chat: 'direct',
                text: ' 看 ',
                quoted: [],
                receivedAt: '',
            }),
        ).toBe('看');
        const t = await setup();
        const c = await t.bound();
        t.steps.push(say('收到'));
        await c.fake.deliver({
            externalUserId: OWNER,
            text: SECRET_TEXT,
            quoted: [{ kind: 'quote', text: '引用的话' }],
        });
        await c.idle();
        expect(s.channels.pruneInbox()).toBe(0);
        s.conn.sqlite.prepare('UPDATE channel_inbox SET received_at = ?').run('2000-01-01T00:00:00.000Z');
        expect(s.channels.pruneInbox()).toBe(2);
        const logs = s.logs.join('');
        expect(logs).toContain(c.channel.id);
        expect(logs).not.toContain(OWNER);
        expect(logs).not.toContain('314159');
        expect(logs).not.toContain('引用的话');
    });
});

describe('approvalReminder', () => {
    const tail = '回复「确认 K7」或「拒绝 K7」,30 分钟内有效。';

    it('没有警告时与原文案逐字相同', () => {
        expect(approvalReminder('Send e-mail', 'K7', 30, undefined, 2048)).toBe(`需要确认:Send e-mail。${tail}`);
        expect(approvalReminder('Send e-mail', 'K7', 30, [], 2048)).toBe(`需要确认:Send e-mail。${tail}`);
    });

    it('每条警告单独一行;过长时截断警告,「回复」一句保持完整且不超限', () => {
        const warnings = [{ message: '收件人不来自你的消息' }, { message: '甲'.repeat(2000) }];
        const short = approvalReminder('Send', 'K7', 30, warnings.slice(0, 1), 2048).split('\n');
        expect(short).toEqual(['需要确认:Send。', '注意:收件人不来自你的消息', tail]);
        const long = approvalReminder('Send', 'K7', 30, warnings, 512);
        expect(Buffer.byteLength(long)).toBeLessThanOrEqual(512);
        expect(long.endsWith(`\n${tail}`)).toBe(true);
        expect(long).toContain('注意:收件人不来自你的消息');
        expect(long).toContain('…');
        // 摘要把空间占满时,警告退成固定的一行,「回复」一句仍在
        const crowded = approvalReminder('x'.repeat(480), 'K7', 30, warnings, 512);
        expect(crowded.endsWith(`\n${tail}`)).toBe(true);
        expect(crowded).toContain('有安全警告');
    });

    it('因长度丢弃警告时加一行「还有 N 条警告」,回复句不被截断;没有丢弃时没有这一行', () => {
        const warnings = Array.from({ length: 6 }, () => ({ message: '甲'.repeat(60) }));
        for (const max of [330, 400, 512]) {
            const out = approvalReminder('Send', 'K7', 30, warnings, max);
            expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max);
            const lines = out.split('\n');
            expect(lines.at(-1)).toBe(tail);
            const kept = lines.filter((l) => l.startsWith('注意:')).length;
            expect(lines.at(-2)).toBe(`还有 ${warnings.length - kept} 条警告,请在 Web 查看。`);
        }
        expect(approvalReminder('Send', 'K7', 30, warnings, 4096)).not.toContain('还有');
    });
});

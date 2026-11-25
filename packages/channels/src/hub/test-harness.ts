// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 包级中枢单测的共用替身(ADR 0050 第 2 节、ADR 0052 第 6 节):临时目录里的真实 SQLite、真实的
// RunManager 与事件总线,模型换成按脚本输出的假 provider,渠道换成假适配器。不从任何入口导出。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, RunManager } from '@fatcat-ai/agent';
import type { ChatChunk, ModelProvider, SecretStore } from '@fatcat-ai/providers';
import type { ChannelKind } from '@fatcat-ai/shared';
import {
    createRepositories,
    openStorage,
    type ChannelRecord,
    type ModelProfileRecord,
    type Repositories,
} from '@fatcat-ai/storage';
import { ToolRegistry, type ToolDefinition } from '@fatcat-ai/tools';
import { FakeChannelAdapter, type FakeAdapterOptions } from '../testing.js';
import { ChannelHub } from './hub.js';

export type Step = () => AsyncGenerator<ChatChunk>;

export const answer = (text: string): Step =>
    async function* () {
        yield { type: 'text-delta', delta: text };
        yield { type: 'finish', reason: 'stop', usage: { totalTokens: 1 } };
    };

export const callTool = (name: string, input: unknown): Step =>
    async function* () {
        yield { type: 'tool-call', callId: 'c1', name, input };
        yield { type: 'finish', reason: 'tool-calls', usage: { totalTokens: 1 } };
    };

export const OWNER = 'owner-account';
export const STRANGER = 'stranger-account';

export interface HarnessOptions {
    kind?: ChannelKind;
    adapter?: FakeAdapterOptions;
    tools?: ToolDefinition[];
    /** resolveProfile 抛错,模拟没有可用的模型配置档。 */
    noModel?: boolean;
    /** 不给这个 kind 注册适配器。 */
    noAdapter?: boolean;
    now?: () => Date;
    /** 每轮的记忆召回是否降级(ADR 0017);返回 true 的轮次发出带 degraded 的 memory-used。 */
    degraded?: () => boolean;
}

export interface HubHarness {
    hub: ChannelHub;
    repos: Repositories;
    runs: RunManager;
    ownerId: string;
    channel: () => ChannelRecord;
    /** 最近一次创建的假适配器(退避重启后会换新的)。 */
    adapter: () => FakeChannelAdapter;
    adapters: FakeChannelAdapter[];
    /** 模型接下来依次输出的步骤;用完后回答「好的」。 */
    steps: Step[];
    /** 模型收到的每次请求里最后一条用户消息。 */
    prompts: string[];
    logs: { level: 'info' | 'warn'; fields: Record<string, unknown>; msg: string }[];
    /** 生成配对码并以主人账号发「绑定 <码>」。 */
    bind(externalUserId?: string): Promise<void>;
    /** 主人发一条私聊,等这条消息排队的一轮处理完。 */
    say(text: string, extra?: Parameters<FakeChannelAdapter['deliver']>[0]): Promise<void>;
    /** 发给主人的全部文本。 */
    replies(): string[];
    close(): Promise<void>;
}

export async function createHubHarness(options: HarnessOptions = {}): Promise<HubHarness> {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-hub-'));
    const { conn } = await openStorage({ dataDir: dir });
    const repos = createRepositories(conn);
    const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    const profile: ModelProfileRecord = repos.modelProfiles.create(ownerId, {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    const steps: Step[] = [];
    const prompts: string[] = [];
    const provider: ModelProvider = {
        profileId: profile.id,
        stream: (request) => {
            const last = [...request.messages].reverse().find((m) => m.role === 'user');
            prompts.push(typeof last?.content === 'string' ? last.content : '');
            return (steps.shift() ?? answer('好的'))();
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    const bus = new EventBus();
    const tools = new ToolRegistry().register(...(options.tools ?? []));
    const degraded = options.degraded;
    const runs = new RunManager({
        repos,
        bus,
        providerFor: () => provider,
        persistIntervalMs: 0,
        tools,
        ...(degraded
            ? {
                  memoryContext: () =>
                      Promise.resolve(
                          degraded()
                              ? {
                                    messages: [],
                                    ids: [],
                                    degraded: [{ path: 'vector' as const, reason: 'timeout' as const }],
                                }
                              : { messages: [], ids: [] },
                      ),
              }
            : {}),
    });
    const logs: HubHarness['logs'] = [];
    const adapters: FakeChannelAdapter[] = [];
    const kind = options.kind ?? 'wechat';
    const hub = new ChannelHub({
        repos,
        runs,
        bus,
        // 中枢只经 ChannelContext.secrets.resolve 用到它;假渠道不读密钥
        secrets: { resolve: () => null, protect: () => undefined } as unknown as SecretStore,
        resolveProfile: () => {
            if (options.noModel) throw new Error('no usable model profile');
            return profile;
        },
        removeSessions: async (owner, ids) => {
            let removed = 0;
            for (const id of ids) {
                const active = repos.sessions.get(owner, id)?.activeRunId;
                if (active) await runs.stop(active);
                if (repos.sessions.delete(owner, id)) removed++;
            }
            return removed;
        },
        logger: {
            info: (fields, msg) => logs.push({ level: 'info', fields, msg }),
            warn: (fields, msg) => logs.push({ level: 'warn', fields, msg }),
        },
        sourceUrl: 'https://example.test/source',
        adapters: options.noAdapter
            ? {}
            : {
                  [kind]: () => {
                      // failStarts 只作用于第一个适配器:退避重启后换上的新适配器正常启动
                      const failStarts = adapters.length === 0 ? (options.adapter?.failStarts ?? 0) : 0;
                      const adapter = new FakeChannelAdapter({ kind, ...options.adapter, failStarts });
                      adapters.push(adapter);
                      return adapter;
                  },
              },
        random: () => 0.5,
        ...(options.now ? { now: options.now } : {}),
    });
    const created = repos.channels.create(ownerId, { kind, label: '测试渠道' });
    const id = created.id;
    const channel = () => repos.channels.byId(id)!;
    await hub.apply(repos.channels.update(ownerId, id, { enabled: true })!);
    const adapter = () => {
        const last = adapters.at(-1);
        if (!last) throw new Error('no adapter was created');
        return last;
    };
    const say: HubHarness['say'] = async (text, extra) => {
        await adapter().deliver({ externalUserId: OWNER, text, ...extra });
        await hub.idle(id);
    };
    return {
        hub,
        repos,
        runs,
        ownerId,
        channel,
        adapter,
        adapters,
        steps,
        prompts,
        logs,
        async bind(externalUserId = OWNER) {
            const { code } = hub.createPairing(channel());
            await adapter().deliver({ externalUserId, text: `绑定 ${code}` });
        },
        say,
        replies: () => adapters.flatMap((a) => a.textsTo(OWNER)),
        async close() {
            await hub.stopAll();
            await runs.idle();
            conn.close();
            // Windows 上 SQLite 句柄可能稍晚才释放:先关连接,删除时重试几次
            rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        },
    };
}

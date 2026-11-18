// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 外连目标清单(ADR 0028):由配置现算,不入库。每个 category 一个具名函数;
// scripts/check-egress.mjs 要求登记表里 kind 为 fixed 的条目的 listedAs 能在本文件找到同名符号。
// 清单只含 origin(协议://主机[:端口]),不含路径、查询、凭据,也不含任何密钥或密钥引用名。
import { ILINK_DEFAULT_BASE_URL } from '@fatcat-ai/channels';
import { ANTHROPIC_BASE_URL, GEMINI_BASE_URL } from '@fatcat-ai/providers';
import { EgressTarget, type EgressTargetList, type McpServer, type VoiceSettings } from '@fatcat-ai/shared';
import type { ChannelRecord, MailAccountRecord, ModelProfileRecord } from '@fatcat-ai/storage';
import { selectEmbedProfile } from './embeddings.js';

export type EgressLog = (message: string, fields: Record<string, unknown>) => void;

const DEFAULT_PORTS: Record<string, string> = {
    'http:': '80',
    'https:': '443',
    'imap:': '143',
    'imaps:': '993',
    'smtp:': '25',
    'smtps:': '465',
};

/**
 * 规范化为 协议://主机[:端口]:小写、省略默认端口、丢弃路径 / 查询 / 片段 / 用户信息。
 * 无法解析时返回 null。
 */
export function normalizeOrigin(address: string): string | null {
    let url: URL;
    try {
        url = new URL(address.trim());
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if (!host || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol.toLowerCase())) return null;
    const protocol = url.protocol.toLowerCase();
    const port = url.port && url.port !== DEFAULT_PORTS[protocol] ? `:${url.port}` : '';
    return `${protocol}//${host}${port}`;
}

type Draft = Omit<EgressTarget, 'origin' | 'local'> & { address: string };

/** 把草稿变成清单项;地址无法解析时跳过并记一条不含地址的日志。 */
function finish(drafts: Draft[], log?: EgressLog): EgressTarget[] {
    const out: EgressTarget[] = [];
    for (const { address, ...rest } of drafts) {
        const origin = normalizeOrigin(address);
        const parsed = origin === null ? null : EgressTarget.safeParse({ ...rest, origin, local: false });
        if (!parsed?.success) {
            log?.('egress target skipped: address cannot be parsed', { id: rest.id, category: rest.category });
            continue;
        }
        out.push(parsed.data);
    }
    return out;
}

function profileAddress(profile: ModelProfileRecord): string | null {
    if (profile.baseURL) return profile.baseURL;
    if (profile.kind === 'anthropic') return ANTHROPIC_BASE_URL;
    if (profile.kind === 'gemini') return GEMINI_BASE_URL;
    return null;
}

/** 对话 / 轻量模型配置档。 */
export function modelTargets(profiles: readonly ModelProfileRecord[], log?: EgressLog): EgressTarget[] {
    const drafts: Draft[] = [];
    for (const p of profiles) {
        if (!p.purpose.some((x) => x === 'chat' || x === 'cheap')) continue;
        const address = profileAddress(p);
        if (address === null) continue;
        drafts.push({
            id: `model:${p.id}`,
            category: 'model',
            label: p.label,
            address,
            source: { kind: 'model-profile', id: p.id },
            enabled: true,
        });
    }
    return finish(drafts, log);
}

/** 嵌入配置档(只有 OpenAI 兼容档会被使用;被选中的那个 enabled)。 */
export function embeddingTargets(profiles: readonly ModelProfileRecord[], log?: EgressLog): EgressTarget[] {
    const chosen = selectEmbedProfile(profiles);
    const drafts: Draft[] = [];
    for (const p of profiles) {
        if (!p.purpose.includes('embed') || p.kind !== 'openai-compatible' || !p.baseURL) continue;
        drafts.push({
            id: `embedding:${p.id}`,
            category: 'embedding',
            label: p.label,
            address: p.baseURL,
            source: { kind: 'model-profile', id: p.id },
            enabled: p.id === chosen?.id,
        });
    }
    return finish(drafts, log);
}

/** 语音:stt 与 tts 各取实际会用的那个配置档(与 /voice 路由的选择规则一致);没有可用档的不列出。 */
export function voiceTargets(
    profiles: readonly ModelProfileRecord[],
    voice: Pick<VoiceSettings, 'defaultSttProfileId' | 'defaultTtsProfileId'>,
    log?: EgressLog,
): EgressTarget[] {
    const drafts: Draft[] = [];
    for (const kind of ['stt', 'tts'] as const) {
        const usable = (p: ModelProfileRecord) =>
            p.kind === 'openai-compatible' && p.baseURL !== undefined && p.purpose.includes(kind);
        const wanted = kind === 'stt' ? voice.defaultSttProfileId : voice.defaultTtsProfileId;
        const p = profiles.find((x) => x.id === wanted && usable(x)) ?? profiles.find(usable);
        if (!p?.baseURL) continue;
        drafts.push({
            id: `voice:${kind}`,
            category: 'voice',
            label: p.label,
            address: p.baseURL,
            source: { kind: 'model-profile', id: p.id },
            enabled: true,
        });
    }
    return finish(drafts, log);
}

/** 邮件账户:IMAP 与 SMTP 各一项。 */
export function mailTargets(accounts: readonly MailAccountRecord[], log?: EgressLog): EgressTarget[] {
    const drafts: Draft[] = [];
    for (const a of accounts) {
        for (const proto of ['imap', 'smtp'] as const) {
            const server = a[proto];
            const scheme = server.security === 'tls' ? `${proto}s` : proto;
            drafts.push({
                id: `mail:${a.id}:${proto}`,
                category: 'mail',
                label: a.label,
                address: `${scheme}://${server.host}:${server.port}`,
                source: { kind: 'mail-account', id: a.id },
                enabled: a.enabled,
            });
        }
    }
    return finish(drafts, log);
}

/** 渠道(目前只有微信 iLink);停用的渠道仍列出。企业微信推迟,不出现。 */
export function channelTargets(channels: readonly ChannelRecord[], log?: EgressLog): EgressTarget[] {
    const drafts: Draft[] = [];
    for (const c of channels) {
        if (c.kind !== 'wechat') continue;
        drafts.push({
            id: `channel:${c.id}`,
            category: 'channel',
            label: c.label,
            address: c.config.baseUrl || ILINK_DEFAULT_BASE_URL,
            source: { kind: 'channel', id: c.id },
            enabled: c.enabled,
        });
    }
    return finish(drafts, log);
}

/** MCP 服务器:目前只有 stdio,是本地进程;其自身的外连不在清单内。 */
export function mcpTargets(servers: readonly McpServer[]): EgressTarget[] {
    return servers.map((s) => ({
        id: `mcp:${s.id}`,
        category: 'mcp' as const,
        label: s.name,
        origin: null,
        local: true,
        source: { kind: 'mcp-server', id: s.id },
        enabled: s.enabled,
    }));
}

/** 插件授权的域名(ADR 0040 第 3.3 节):每个域名一项,类别 `plugin`;插件自己不能联网,只能经主程序代发。 */
export interface PluginEgressDomain {
    pluginId: string;
    name: string;
    domain: string;
    enabled: boolean;
}

export function pluginTargets(domains: readonly PluginEgressDomain[]): EgressTarget[] {
    return domains.map((d) => ({
        id: `plugin:${d.pluginId}:${d.domain}`,
        category: 'plugin' as const,
        label: d.name,
        origin: `https://${d.domain}`,
        local: false,
        source: { kind: 'plugin', id: d.pluginId },
        enabled: d.enabled,
    }));
}

export interface EgressInputs {
    profiles: readonly ModelProfileRecord[];
    voice: Pick<VoiceSettings, 'defaultSttProfileId' | 'defaultTtsProfileId'>;
    mailAccounts: readonly MailAccountRecord[];
    channels: readonly ChannelRecord[];
    mcpServers: readonly McpServer[];
    plugins?: readonly PluginEgressDomain[];
    /** 插件市场的索引与下载主机(ADR 0040 第 5.3 节);市场关闭时为空。 */
    pluginMarkets?: readonly EgressTarget[];
}

/** GET /settings/egress-targets 的内容。当前没有更新检查,这一类不出现。 */
export function listEgressTargets(input: EgressInputs, log?: EgressLog): EgressTargetList {
    return {
        targets: [
            ...modelTargets(input.profiles, log),
            ...embeddingTargets(input.profiles, log),
            ...voiceTargets(input.profiles, input.voice, log),
            ...mailTargets(input.mailAccounts, log),
            ...channelTargets(input.channels, log),
            ...mcpTargets(input.mcpServers),
            ...pluginTargets(input.plugins ?? []),
            ...(input.pluginMarkets ?? []),
        ],
    };
}

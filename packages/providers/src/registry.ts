// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelPurpose } from '@ai-personal/shared';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import type { Redactor } from './redact.js';
import type { SecretStore } from './secrets.js';
import type { ModelProvider, ProviderProfile } from './types.js';

export interface ProviderDeps {
    secrets: SecretStore;
    redactor: Redactor;
    fetch?: typeof fetch;
    firstTokenTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

/** 按配置档创建 provider;密钥在每次请求时才解析。三种类型都只用 fetch 实现(ADR 0006)。 */
export function createProvider(profile: ProviderProfile, deps: ProviderDeps): ModelProvider {
    const options = {
        profile,
        getApiKey: () => deps.secrets.resolve(profile.apiKeyRef),
        redactor: deps.redactor,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.firstTokenTimeoutMs ? { firstTokenTimeoutMs: deps.firstTokenTimeoutMs } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
    };
    switch (profile.kind) {
        case 'openai-compatible':
            return createOpenAICompatibleProvider(options);
        case 'anthropic':
            return createAnthropicProvider(options);
        case 'gemini':
            return createGeminiProvider(options);
    }
}

/**
 * 按用途选配置档:优先用设置中的默认值,其次是第一个声明了该用途的配置档;
 * cheap 用途找不到时回退到 chat(ADR 0006)。
 */
export function selectProfile<P extends ProviderProfile>(
    profiles: readonly P[],
    purpose: Extract<ModelPurpose, 'chat' | 'cheap'>,
    defaults: { chat?: string | null; cheap?: string | null } = {},
): P | null {
    const byId = (id: string | null | undefined) => (id ? (profiles.find((p) => p.id === id) ?? null) : null);
    const pick = (p: 'chat' | 'cheap') => byId(defaults[p]) ?? profiles.find((x) => x.purpose.includes(p)) ?? null;
    return purpose === 'cheap' ? (pick('cheap') ?? pick('chat')) : pick('chat');
}

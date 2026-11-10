// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelKind, ModelProfileInput, ModelPurpose } from '@fatcat-ai/client';
import { connect, parse, resolveModelId, table } from '../common.js';
import { type Ctx, status, UsageError } from '../io.js';

const USAGE = [
    'Usage: fatcat-ai models list',
    '       fatcat-ai models add --label <name> --base-url <url> --model <name> [--key-ref env:NAME|file:NAME]',
    '                              [--kind openai-compatible|anthropic|gemini] [--purpose chat,cheap]',
    '       fatcat-ai models test <id|label>',
].join('\n');

const KINDS: readonly ModelKind[] = ['openai-compatible', 'anthropic', 'gemini'];
const PURPOSES: readonly ModelPurpose[] = ['chat', 'cheap', 'embed', 'stt', 'tts'];

export async function modelsCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, {
        label: { type: 'string' },
        kind: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        'key-ref': { type: 'string' },
        purpose: { type: 'string' },
        json: { type: 'boolean' },
    });
    const { client } = connect(ctx, values.server);

    if (sub === 'list') {
        const { items } = await client.models.list();
        if (values.json) {
            ctx.stdout.write(`${JSON.stringify(items)}\n`);
            return 0;
        }
        if (items.length === 0) {
            status(ctx, 'No model profiles yet; add one with "fatcat-ai models add"');
            return 0;
        }
        table(ctx, [
            ['ID', 'LABEL', 'MODEL', 'PURPOSE', 'KEY'],
            ...items.map((m) => [m.id, m.label, m.model, m.purpose.join(','), m.keyStatus]),
        ]);
        return 0;
    }

    if (sub === 'add') {
        const kind = (values.kind ?? 'openai-compatible') as ModelKind;
        if (!KINDS.includes(kind)) throw new UsageError(`--kind must be one of ${KINDS.join(', ')}`);
        const purpose = (values.purpose ?? 'chat').split(',').map((p) => p.trim()) as ModelPurpose[];
        if (purpose.some((p) => !PURPOSES.includes(p))) {
            throw new UsageError(`--purpose must be a comma list of ${PURPOSES.join(', ')}`);
        }
        if (!values.label || !values.model) throw new UsageError(USAGE);
        // 只接受密钥引用,不接受明文密钥(ADR 0006、M1 决定 1)
        const keyRef = values['key-ref'] ?? null;
        if (keyRef !== null && !/^(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(keyRef)) {
            throw new UsageError('--key-ref must be env:NAME or file:NAME (never the key itself)');
        }
        const input: ModelProfileInput = {
            label: values.label,
            kind,
            model: values.model,
            apiKeyRef: keyRef,
            purpose,
            ...(values['base-url'] ? { baseURL: values['base-url'] } : {}),
        };
        const created = await client.models.create(input);
        ctx.stdout.write(`${created.id}\n`);
        status(ctx, `Added "${created.label}" (key: ${created.keyStatus})`);
        return 0;
    }

    if (sub === 'test') {
        const id = await resolveModelId(client, positionals[0]);
        if (!id) throw new UsageError(USAGE);
        const result = await client.models.test(id);
        if (values.json) ctx.stdout.write(`${JSON.stringify(result)}\n`);
        else if (result.ok) ctx.stdout.write(`ok (${Math.round(result.latencyMs)} ms)\n`);
        else ctx.stdout.write(`failed: ${result.error}: ${result.message}\n`);
        return result.ok ? 0 : 1;
    }

    throw new UsageError(USAGE);
}

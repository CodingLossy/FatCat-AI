// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute } from '@hono/zod-openapi';
import { migrateSecrets, readSecretsStatus, type SecretStore, SecretsMigrateError } from '@fatcat-ai/providers';
import {
    type CodeProject,
    type CodeProjectInput,
    effectiveTimeZone,
    type EgressTarget,
    EgressTargetList,
    SecretsMigrateRequest,
    SecretsMigrateResponse,
    SecretsStatus,
    serverTimeZone,
    Settings,
    SettingsPatch,
    supportedTimeZones,
    TimeZoneInfo,
} from '@fatcat-ai/shared';
import { newId, type Repositories } from '@fatcat-ai/storage';
import { checkProjectPath } from '@fatcat-ai/tools';
import { requireOwner } from '../auth/middleware.js';
import { listEgressTargets, type PluginEgressDomain } from '../egress.js';
import { ApiError } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const getRoute = createRoute({
    method: 'get',
    path: '/settings',
    tags: ['settings'],
    summary: 'Get settings (defaults are filled in for keys never set)',
    responses: { 200: json(Settings, 'Settings'), ...authErrors },
});

const putRoute = createRoute({
    method: 'put',
    path: '/settings',
    tags: ['settings'],
    summary: 'Update settings; only the given keys change and memory is merged',
    request: { body: { content: { 'application/json': { schema: SettingsPatch } }, required: true } },
    responses: { 200: json(Settings, 'Updated settings'), 400: problem('Invalid request'), ...authErrors },
});

const timeZonesRoute = createRoute({
    method: 'get',
    path: '/settings/time-zones',
    tags: ['settings'],
    summary: "Time zones the server recognizes, and the server's own time zone (used when timeZone is null)",
    responses: { 200: json(TimeZoneInfo, 'Time zones'), ...authErrors },
});

const egressTargetsRoute = createRoute({
    method: 'get',
    path: '/settings/egress-targets',
    tags: ['settings'],
    summary:
        'Where this server may connect to, computed from the current configuration (origins only; never credentials). Per-call destinations chosen in a conversation (web.fetch) are not listed',
    responses: { 200: json(EgressTargetList, 'Egress targets'), ...authErrors },
});

const secretsStatusRoute = createRoute({
    method: 'get',
    path: '/settings/secrets',
    tags: ['settings'],
    summary: 'Secrets storage status: file state, master key source and fingerprint (never any secret value)',
    responses: {
        200: json(SecretsStatus, 'Secrets status'),
        409: problem('secrets.yaml and secrets.yaml.enc both exist; the message says what to do'),
        ...authErrors,
    },
});

const secretsMigrateRoute = createRoute({
    method: 'post',
    path: '/settings/secrets/migrate',
    tags: ['settings'],
    summary:
        'Encrypt secrets.yaml (explicit; requires confirm: true). The plaintext file is kept as secrets.yaml.migrated',
    request: { body: { content: { 'application/json': { schema: SecretsMigrateRequest } }, required: true } },
    responses: {
        200: json(SecretsMigrateResponse, 'Migrated'),
        400: problem('Invalid request or unreadable secrets.yaml'),
        409: problem('Nothing to migrate, already encrypted, or the master key is unavailable'),
        ...authErrors,
    },
});

const invalid = (path: (string | number)[], message: string) =>
    new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', { issues: [{ path, message }] });

/**
 * 编码项目(ADR 0049 第 3.1 节):名字不区分大小写不能重复,同一项目的命令名不能重复;路径必须在已授权文件夹之内
 * 且是 git 仓库,保存为真实路径;新项目由服务器生成 id。
 */
function checkCodeProjects(projects: readonly CodeProjectInput[], roots: readonly string[]): CodeProject[] {
    const names = new Set<string>();
    const ids = new Set<string>();
    return projects.map((p, i) => {
        const name = p.name.trim();
        if (names.has(name.toLowerCase())) throw invalid(['code', 'projects', i, 'name'], 'Duplicate project name');
        names.add(name.toLowerCase());
        const commandNames = new Set<string>();
        p.commands.forEach((c, j) => {
            if (commandNames.has(c.name)) {
                throw invalid(['code', 'projects', i, 'commands', j, 'name'], 'Duplicate command name');
            }
            commandNames.add(c.name);
        });
        let path: string;
        try {
            path = checkProjectPath(p.path, roots);
        } catch (error) {
            throw invalid(['code', 'projects', i, 'path'], error instanceof Error ? error.message : 'Invalid path');
        }
        let id = p.id ?? newId();
        if (ids.has(id)) id = newId();
        ids.add(id);
        return { id, name, path, commands: p.commands };
    });
}

export function settingsRoutes(deps: {
    repos: Repositories;
    /** 密钥存储;迁移与状态都经过它(ADR 0026)。 */
    secrets: SecretStore;
    /** 只记迁移的键数与指纹,不记任何密钥值。 */
    log?: (message: string, fields: Record<string, unknown>) => void;
    /** 生效时区变化后调用(ADR 0023 第 5 节)。 */
    onTimeZoneChanged?: ((ownerId: string, timeZone: string) => void) | undefined;
    /** 外连清单里的插件域名(ADR 0040)。 */
    pluginDomains?: ((ownerId: string) => PluginEgressDomain[]) | undefined;
    /** 外连清单里的插件市场地址(索引与下载主机);关闭市场时为空。 */
    pluginMarkets?: ((ownerId: string) => EgressTarget[]) | undefined;
}) {
    const { repos } = deps;
    const roots = (ownerId: string) => repos.fsRoots.list(ownerId).map((r) => r.path);
    return router()
        .openapi(getRoute, (c) => c.json(repos.settings.get(requireOwner(c)), 200))
        .openapi(timeZonesRoute, (c) => {
            requireOwner(c); // 服务器时区会透露部署位置,需要登录
            return c.json({ serverTimeZone: serverTimeZone(), supported: supportedTimeZones() }, 200);
        })
        .openapi(egressTargetsRoute, (c) => {
            const ownerId = requireOwner(c);
            return c.json(
                listEgressTargets(
                    {
                        profiles: repos.modelProfiles.list(ownerId),
                        voice: repos.settings.get(ownerId).voice,
                        mailAccounts: repos.mail.list(ownerId),
                        channels: repos.channels.list(ownerId),
                        mcpServers: repos.mcpServers.list(ownerId),
                        plugins: deps.pluginDomains?.(ownerId) ?? [],
                        pluginMarkets: deps.pluginMarkets?.(ownerId) ?? [],
                    },
                    deps.log,
                ),
                200,
            );
        })
        .openapi(secretsStatusRoute, (c) => {
            requireOwner(c);
            try {
                return c.json(readSecretsStatus(deps.secrets.dataDir, deps.secrets.masterKey), 200);
            } catch (error) {
                // 明文与密文并存:服务器启动时本来就会拒绝;这里给出处理办法,而不是 500
                if (error instanceof SecretsMigrateError && error.code === 'conflict') {
                    throw new ApiError(
                        409,
                        'conflict',
                        'Conflict',
                        'secrets.yaml and secrets.yaml.enc both exist in the data directory. Keep the one you want and move the other out of the data directory (for example rename secrets.yaml to secrets.yaml.old), then restart the server. Nothing was changed.',
                    );
                }
                throw error;
            }
        })
        .openapi(secretsMigrateRoute, (c) => {
            requireOwner(c);
            const body = c.req.valid('json');
            const keys = deps.secrets.masterKey;
            if (!keys) throw new ApiError(409, 'conflict', 'Conflict', 'The master key is unavailable.');
            try {
                const result = migrateSecrets({
                    dataDir: deps.secrets.dataDir,
                    keys,
                    plaintextBackups: body.plaintextBackups,
                });
                deps.log?.('secrets migrated to the encrypted file', {
                    migratedKeys: result.migratedKeys,
                    fingerprint: result.fingerprint,
                    plaintextBackups: body.plaintextBackups,
                });
                return c.json(result, 200);
            } catch (error) {
                if (!(error instanceof SecretsMigrateError)) throw error;
                if (error.code === 'plaintext_invalid') {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', error.message);
                }
                if (error.code === 'write_failed' || error.code === 'verify_failed') {
                    throw new ApiError(
                        500,
                        'internal',
                        'Internal Server Error',
                        `${error.message}. Nothing was changed.`,
                    );
                }
                throw new ApiError(409, 'conflict', 'Conflict', error.message);
            } finally {
                deps.secrets.invalidate();
            }
        })
        .openapi(putRoute, (c) => {
            const ownerId = requireOwner(c);
            const patch = c.req.valid('json');
            for (const key of ['defaultChatProfileId', 'defaultCheapProfileId'] as const) {
                const id = patch[key];
                if (id && !repos.modelProfiles.get(ownerId, id)) {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
                        issues: [{ path: [key], message: 'Model profile does not exist' }],
                    });
                }
            }
            // 语音默认配置档必须是 OpenAI 兼容且声明了对应用途(ADR 0021 第 1、2 节)
            for (const [key, purpose] of [
                ['defaultSttProfileId', 'stt'],
                ['defaultTtsProfileId', 'tts'],
            ] as const) {
                const id = patch.voice?.[key];
                if (!id) continue;
                const p = repos.modelProfiles.get(ownerId, id);
                const message = !p
                    ? 'Model profile does not exist'
                    : p.kind !== 'openai-compatible' || !p.purpose.includes(purpose)
                      ? `Model profile must be openai-compatible with purpose ${purpose}`
                      : null;
                if (message) {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
                        issues: [{ path: ['voice', key], message }],
                    });
                }
            }
            if (patch.code?.projects) {
                patch.code = { ...patch.code, projects: checkCodeProjects(patch.code.projects, roots(ownerId)) };
            }
            const before = effectiveTimeZone(repos.settings.get(ownerId).timeZone);
            const updated = repos.settings.update(ownerId, patch);
            const after = effectiveTimeZone(updated.timeZone);
            if (after !== before) deps.onTimeZoneChanged?.(ownerId, after);
            return c.json(updated, 200);
        });
}

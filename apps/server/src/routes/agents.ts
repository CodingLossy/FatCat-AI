// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 代理(ADR 0042)的 REST:只有登录的主人能管理,没有对应的 Agent 工具。
import { createRoute, z } from '@hono/zod-openapi';
import type { RunManager, StartRunInput } from '@fatcat-ai/agent';
import {
    Agent,
    AgentCopyInput,
    AgentInput,
    AgentPatch,
    BUILTIN_AGENT_ROLES,
    effectiveAgentPrompt,
    Id,
    pageOf,
    toolInSet,
} from '@fatcat-ai/shared';
import {
    AgentNameTakenError,
    BuiltinAgentError,
    type AgentRecord,
    type ModelProfileRecord,
    type Repositories,
} from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['agents'];
const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/agents',
    tags,
    summary: 'List agents: the built-in roles (read-only) and your own',
    responses: { 200: json(pageOf(Agent), 'Agents'), ...authErrors },
});
const createAgentRoute = createRoute({
    method: 'post',
    path: '/agents',
    tags,
    summary:
        'Create an agent: a persona with its own model profile and a tool set that can only narrow what is allowed',
    request: { body: { content: { 'application/json': { schema: AgentInput } }, required: true } },
    responses: {
        201: json(Agent, 'Created'),
        400: problem('Invalid request, unknown tool or model profile'),
        409: problem('An agent with this name already exists'),
        ...authErrors,
    },
});
const getRoute = createRoute({
    method: 'get',
    path: '/agents/{id}',
    tags,
    summary: 'One agent',
    request: { params: idParam },
    responses: { 200: json(Agent, 'The agent'), 404: problem('Not found'), ...authErrors },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/agents/{id}',
    tags,
    summary: 'Change a custom agent (built-in roles are read-only: copy them first)',
    request: { params: idParam, body: { content: { 'application/json': { schema: AgentPatch } }, required: true } },
    responses: {
        200: json(Agent, 'Updated'),
        400: problem('Invalid request, unknown tool or model profile'),
        404: problem('Not found'),
        409: problem('Built-in role, or the name is taken'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/agents/{id}',
    tags,
    summary: 'Delete a custom agent; past runs keep their history',
    request: { params: idParam },
    responses: {
        204: { description: 'Deleted' },
        404: problem('Not found'),
        409: problem('Built-in roles cannot be deleted'),
        ...authErrors,
    },
});
const copyRoute = createRoute({
    method: 'post',
    path: '/agents/{id}/copy',
    tags,
    summary: 'Copy an agent (for example a built-in role) into a custom one you can edit',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: AgentCopyInput } }, required: false },
    },
    responses: {
        201: json(Agent, 'The copy'),
        404: problem('Not found'),
        409: problem('The name is taken'),
        ...authErrors,
    },
});

type Locale = 'zh-CN' | 'en';
const localeOf = (repos: Repositories, ownerId: string): Locale =>
    repos.settings.get(ownerId).locale === 'en' ? 'en' : 'zh-CN';

export function agentView(agent: AgentRecord, locale: Locale, skills: string[] = []): Agent {
    return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        builtin: agent.builtin,
        systemPrompt: effectiveAgentPrompt(agent, locale),
        modelProfileId: agent.modelProfileId,
        toolSet: agent.toolSet,
        memoryScope: agent.memoryScope,
        maxDepth: agent.maxDepth,
        maxSteps: agent.maxSteps,
        budgetTokens: agent.budgetTokens,
        budgetSeconds: agent.budgetSeconds,
        skills,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
    };
}

/**
 * 发消息 / 重试 / 重新生成时用的代理:找不到(例如已删除)返回 404;返回 RunManager 需要的 `agent` 字段。
 * 模型配置档由调用方按「请求 > 代理 > 会话」的顺序选(见 sessions.ts)。
 */
export function loadRunAgent(
    repos: Repositories,
    ownerId: string,
    agentId: string,
): { record: AgentRecord; runAgent: NonNullable<StartRunInput['agent']> } {
    const record = repos.agents.get(ownerId, agentId);
    if (!record) throw notFound('Agent');
    return {
        record,
        runAgent: runAgentOf(repos, record, localeOf(repos, ownerId)),
    };
}

/** 代理的 Skill 列表(ADR 0048 第 8 节,存在 settings 表里;已不存在的代理的条目读取时忽略)。 */
function skillsOf(repos: Repositories, record: AgentRecord): string[] {
    return repos.settings.agentSkills(record.ownerId)[record.id] ?? [];
}

function runAgentOf(repos: Repositories, record: AgentRecord, locale: Locale): NonNullable<StartRunInput['agent']> {
    const skills = skillsOf(repos, record);
    return {
        id: record.id,
        name: record.name,
        prompt: effectiveAgentPrompt(record, locale),
        toolSet: record.toolSet,
        memoryScope: record.memoryScope,
        maxSteps: record.maxSteps,
        maxDepth: record.maxDepth,
        budgetTokens: record.budgetTokens,
        budgetSeconds: record.budgetSeconds,
        ...(skills.length > 0 ? { skills } : {}),
    };
}

/**
 * delegate 工具按名称(或 id)找子代理:预置角色首次用到时也会创建;模型配置档按「代理 > 委派者」,
 * 所以这里只给出代理自己的配置档(没有或已删除时为 null)。
 */
export function resolveDelegateAgent(
    repos: Repositories,
    ownerId: string,
    ref: string,
): { agent: NonNullable<StartRunInput['agent']>; profile: ModelProfileRecord | null } | null {
    const locale = localeOf(repos, ownerId);
    repos.agents.ensureBuiltins(ownerId, BUILTIN_AGENT_ROLES, locale);
    const all = repos.agents.list(ownerId);
    const record = all.find((a) => a.name === ref) ?? all.find((a) => a.id === ref);
    if (!record) return null;
    return {
        agent: runAgentOf(repos, record, locale),
        profile: record.modelProfileId ? repos.modelProfiles.getUsable(ownerId, record.modelProfileId) : null,
    };
}

export function agentRoutes(deps: { repos: Repositories; runs: Pick<RunManager, 'tools'> }) {
    const { repos } = deps;
    const issue = (path: (string | number)[], message: string, reason: string) =>
        new ApiError(400, 'validation_failed', 'Bad Request', message, { issues: [{ path, message }], reason });
    /** 工具集的每一项必须是已注册的工具名,或至少匹配一个已注册工具的前缀(与任务的 toolSet 同一规则)。 */
    const checkToolSet = (toolSet: string[] | undefined) => {
        const known = deps.runs.tools?.info() ?? [];
        toolSet?.forEach((entry, i) => {
            if (!known.some((tool) => toolInSet(tool.name, [entry]))) {
                throw issue(['toolSet', i], 'Unknown tool or prefix.', 'agent_toolset_unknown');
            }
        });
    };
    const checkProfile = (ownerId: string, profileId: string | null | undefined) => {
        if (profileId && !repos.modelProfiles.getUsable(ownerId, profileId)) {
            throw issue(['modelProfileId'], 'The model profile does not exist.', 'agent_profile_missing');
        }
    };
    const taken = () => new ApiError(409, 'conflict', 'Conflict', 'An agent with this name already exists.');
    const builtin = () =>
        new ApiError(409, 'conflict', 'Conflict', 'Built-in roles are read-only. Copy it to make your own.', {
            reason: 'agent_builtin',
        });
    const get = (ownerId: string, id: string) => {
        const agent = repos.agents.get(ownerId, id);
        if (!agent) throw notFound('Agent');
        return agent;
    };

    return router()
        .openapi(listRoute, (c) => {
            const ownerId = requireOwner(c);
            const locale = localeOf(repos, ownerId);
            repos.agents.ensureBuiltins(ownerId, BUILTIN_AGENT_ROLES, locale);
            const skills = repos.settings.agentSkills(ownerId);
            return c.json(
                {
                    items: repos.agents.list(ownerId).map((a) => agentView(a, locale, skills[a.id] ?? [])),
                    nextCursor: null,
                },
                200,
            );
        })
        .openapi(createAgentRoute, (c) => {
            const ownerId = requireOwner(c);
            const body = AgentInput.parse(c.req.valid('json'));
            checkToolSet(body.toolSet);
            checkProfile(ownerId, body.modelProfileId);
            try {
                const { skills, ...input } = body;
                const agent = repos.agents.create(ownerId, input);
                if (skills?.length) repos.settings.setAgentSkills(ownerId, agent.id, skills);
                return c.json(agentView(agent, localeOf(repos, ownerId), skills ?? []), 201);
            } catch (error) {
                if (error instanceof AgentNameTakenError) throw taken();
                throw error;
            }
        })
        .openapi(getRoute, (c) => {
            const ownerId = requireOwner(c);
            const agent = get(ownerId, c.req.valid('param').id);
            return c.json(agentView(agent, localeOf(repos, ownerId), skillsOf(repos, agent)), 200);
        })
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            const body = c.req.valid('json');
            get(ownerId, id);
            checkToolSet(body.toolSet);
            checkProfile(ownerId, body.modelProfileId);
            try {
                const { skills, ...rest } = body;
                const changes = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
                // 预置角色是只读的:只改 Skill 也一样,先走一次 update 让它报 BuiltinAgentError
                const agent = repos.agents.update(ownerId, id, changes);
                if (!agent) throw notFound('Agent');
                if (skills !== undefined) repos.settings.setAgentSkills(ownerId, id, skills);
                return c.json(agentView(agent, localeOf(repos, ownerId), skillsOf(repos, agent)), 200);
            } catch (error) {
                if (error instanceof AgentNameTakenError) throw taken();
                if (error instanceof BuiltinAgentError) throw builtin();
                throw error;
            }
        })
        .openapi(deleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            try {
                if (!repos.agents.delete(ownerId, id)) throw notFound('Agent');
                repos.settings.setAgentSkills(ownerId, id, null);
            } catch (error) {
                if (error instanceof BuiltinAgentError) throw builtin();
                throw error;
            }
            return c.body(null, 204);
        })
        .openapi(copyRoute, (c) => {
            const ownerId = requireOwner(c);
            const source = get(ownerId, c.req.valid('param').id);
            const locale = localeOf(repos, ownerId);
            const body = c.req.valid('json') ?? {};
            try {
                const copy = repos.agents.create(ownerId, {
                    name: body.name ?? `${source.name} (copy)`.slice(0, 80),
                    systemPrompt: effectiveAgentPrompt(source, locale),
                    modelProfileId: source.modelProfileId,
                    toolSet: source.toolSet,
                    memoryScope: source.memoryScope,
                    maxDepth: source.maxDepth,
                    maxSteps: source.maxSteps,
                    budgetTokens: source.budgetTokens,
                    budgetSeconds: source.budgetSeconds,
                });
                const skills = skillsOf(repos, source);
                if (skills.length > 0) repos.settings.setAgentSkills(ownerId, copy.id, skills);
                return c.json(agentView(copy, locale, skills), 201);
            } catch (error) {
                if (error instanceof AgentNameTakenError) throw taken();
                throw error;
            }
        });
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AgentMemoryScope, BuiltinAgentRole } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';

/** 代理配置(ADR 0042)。预置角色(builtin)的 systemPrompt 为空,提示词按语言取自代码。 */
export interface AgentRecord {
    id: string;
    ownerId: string;
    name: string;
    role: string;
    builtin: boolean;
    systemPrompt: string;
    modelProfileId: string | null;
    toolSet: string[];
    memoryScope: AgentMemoryScope;
    maxDepth: number;
    maxSteps: number;
    budgetTokens: number | null;
    budgetSeconds: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface NewAgent {
    name: string;
    systemPrompt: string;
    modelProfileId: string | null;
    toolSet: string[];
    memoryScope: AgentMemoryScope;
    maxDepth: number;
    maxSteps: number;
    budgetTokens: number | null;
    budgetSeconds: number | null;
}

export type AgentChanges = Partial<NewAgent>;

interface Row {
    id: string;
    ownerId: string;
    name: string;
    role: string;
    builtin: number;
    systemPrompt: string;
    modelProfileId: string | null;
    toolSetJson: string;
    memoryScope: AgentMemoryScope;
    maxDepth: number;
    maxSteps: number;
    budgetTokens: number | null;
    budgetSeconds: number | null;
    createdAt: string;
    updatedAt: string;
}

const SELECT = `SELECT id, owner_id AS ownerId, name, role, builtin, system_prompt AS systemPrompt,
    model_profile_id AS modelProfileId, tool_set_json AS toolSetJson, memory_scope AS memoryScope,
    max_depth AS maxDepth, max_steps AS maxSteps, budget_tokens AS budgetTokens, budget_seconds AS budgetSeconds,
    created_at AS createdAt, updated_at AS updatedAt FROM agents`;

function toAgent(row: Row): AgentRecord {
    const { toolSetJson, builtin, ...rest } = row;
    return { ...rest, builtin: builtin === 1, toolSet: JSON.parse(toolSetJson) as string[] };
}

export class AgentNameTakenError extends Error {
    override readonly name = 'AgentNameTakenError';
}

export class BuiltinAgentError extends Error {
    override readonly name = 'BuiltinAgentError';
}

function isUnique(error: unknown): boolean {
    return (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function createAgentRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], Row>(`${SELECT} WHERE owner_id = ? ORDER BY builtin DESC, name`),
        get: sqlite.prepare<[string, string], Row>(`${SELECT} WHERE owner_id = ? AND id = ?`),
        builtinRole: sqlite.prepare<[string, string], Row>(`${SELECT} WHERE owner_id = ? AND builtin = 1 AND role = ?`),
        insert: sqlite.prepare(
            `INSERT INTO agents (id, owner_id, name, role, builtin, system_prompt, model_profile_id, tool_set_json,
               memory_scope, max_depth, max_steps, budget_tokens, budget_seconds, created_at, updated_at)
             VALUES (@id, @ownerId, @name, @role, @builtin, @systemPrompt, @modelProfileId, @toolSetJson,
               @memoryScope, @maxDepth, @maxSteps, @budgetTokens, @budgetSeconds, @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE agents SET name = @name, system_prompt = @systemPrompt, model_profile_id = @modelProfileId,
               tool_set_json = @toolSetJson, memory_scope = @memoryScope, max_depth = @maxDepth, max_steps = @maxSteps,
               budget_tokens = @budgetTokens, budget_seconds = @budgetSeconds, updated_at = @at
             WHERE owner_id = @ownerId AND id = @id`,
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM agents WHERE owner_id = ? AND id = ? AND builtin = 0'),
    };

    const insert = (ownerId: string, input: NewAgent, role: string, builtin: boolean): AgentRecord => {
        const id = newId(now());
        try {
            q.insert.run({
                id,
                ownerId,
                name: input.name,
                role,
                builtin: builtin ? 1 : 0,
                systemPrompt: input.systemPrompt,
                modelProfileId: input.modelProfileId,
                toolSetJson: JSON.stringify(input.toolSet),
                memoryScope: input.memoryScope,
                maxDepth: input.maxDepth,
                maxSteps: input.maxSteps,
                budgetTokens: input.budgetTokens,
                budgetSeconds: input.budgetSeconds,
                at: now().toISOString(),
            });
        } catch (error) {
            if (isUnique(error)) throw new AgentNameTakenError(input.name);
            throw error;
        }
        return toAgent(q.get.get(ownerId, id)!);
    };

    return {
        list(ownerId: string): AgentRecord[] {
            return q.list.all(ownerId).map(toAgent);
        },
        get(ownerId: string, id: string): AgentRecord | null {
            const row = q.get.get(ownerId, id);
            return row ? toAgent(row) : null;
        },
        /** 自定义代理;名字在同一 owner 下唯一。 */
        create(ownerId: string, input: NewAgent): AgentRecord {
            return insert(ownerId, input, 'custom', false);
        },
        /**
         * 补齐缺少的预置角色(幂等)。名字用 `names[locale]`;若名字已被自定义代理占用就加后缀,
         * 保证预置角色一定能建出来。已存在的预置角色不会被覆盖。
         */
        ensureBuiltins(ownerId: string, roles: readonly BuiltinAgentRole[], locale: 'zh-CN' | 'en'): void {
            for (const role of roles) {
                if (q.builtinRole.get(ownerId, role.role)) continue;
                const base = role.name[locale];
                for (let attempt = 0; attempt < 10; attempt++) {
                    const name = attempt === 0 ? base : `${base} (${attempt + 1})`;
                    try {
                        insert(
                            ownerId,
                            {
                                name,
                                systemPrompt: '',
                                modelProfileId: null,
                                toolSet: role.toolSet,
                                memoryScope: 'shared',
                                maxDepth: 0,
                                maxSteps: 5,
                                budgetTokens: null,
                                budgetSeconds: null,
                            },
                            role.role,
                            true,
                        );
                        break;
                    } catch (error) {
                        if (!(error instanceof AgentNameTakenError)) throw error;
                    }
                }
            }
        },
        /** 预置角色不能修改(复制后再改),抛 BuiltinAgentError。 */
        update(ownerId: string, id: string, changes: AgentChanges): AgentRecord | null {
            const row = q.get.get(ownerId, id);
            if (!row) return null;
            if (row.builtin === 1) throw new BuiltinAgentError(row.name);
            const current = toAgent(row);
            const next = { ...current, ...changes };
            try {
                q.update.run({
                    ownerId,
                    id,
                    name: next.name,
                    systemPrompt: next.systemPrompt,
                    modelProfileId: next.modelProfileId,
                    toolSetJson: JSON.stringify(next.toolSet),
                    memoryScope: next.memoryScope,
                    maxDepth: next.maxDepth,
                    maxSteps: next.maxSteps,
                    budgetTokens: next.budgetTokens,
                    budgetSeconds: next.budgetSeconds,
                    at: now().toISOString(),
                });
            } catch (error) {
                if (isUnique(error)) throw new AgentNameTakenError(next.name);
                throw error;
            }
            return toAgent(q.get.get(ownerId, id)!);
        },
        /** 预置角色不能删除,抛 BuiltinAgentError;不存在返回 false。 */
        delete(ownerId: string, id: string): boolean {
            const row = q.get.get(ownerId, id);
            if (!row) return false;
            if (row.builtin === 1) throw new BuiltinAgentError(row.name);
            return q.delete.run(ownerId, id).changes > 0;
        },
    };
}

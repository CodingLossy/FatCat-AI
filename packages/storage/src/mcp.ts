// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { McpServer, ToolRisk } from '@ai-personal/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';

interface Row {
    id: string;
    name: string;
    command: string;
    argsJson: string;
    cwd: string | null;
    envNamesJson: string;
    enabled: number;
    toolRisksJson: string;
    createdAt: string;
}

const COLUMNS = `id, name, command, args_json AS argsJson, cwd, env_names_json AS envNamesJson, enabled,
    tool_risks_json AS toolRisksJson, created_at AS createdAt`;

function toServer(row: Row): McpServer {
    return {
        id: row.id,
        name: row.name,
        command: row.command,
        args: JSON.parse(row.argsJson) as string[],
        cwd: row.cwd,
        envPassthrough: JSON.parse(row.envNamesJson) as string[],
        enabled: row.enabled === 1,
        toolRisks: JSON.parse(row.toolRisksJson) as Record<string, ToolRisk>,
        createdAt: row.createdAt,
    };
}

/** MCP 服务器配置(ADR 0013)。 */
export function createMcpServerRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], Row>(`SELECT ${COLUMNS} FROM mcp_servers WHERE owner_id = ? ORDER BY name`),
        all: sqlite.prepare<[], Row & { ownerId: string }>(
            `SELECT ${COLUMNS}, owner_id AS ownerId FROM mcp_servers WHERE enabled = 1 ORDER BY name`,
        ),
        get: sqlite.prepare<[string, string], Row>(`SELECT ${COLUMNS} FROM mcp_servers WHERE owner_id = ? AND id = ?`),
        insert: sqlite.prepare(
            `INSERT INTO mcp_servers (id, owner_id, name, command, args_json, cwd, env_names_json, enabled,
               tool_risks_json, created_at, updated_at)
             VALUES (@id, @ownerId, @name, @command, @args, @cwd, @env, @enabled, @risks, @at, @at)`,
        ),
        update: sqlite.prepare(
            'UPDATE mcp_servers SET enabled = @enabled, tool_risks_json = @risks, updated_at = @at WHERE id = @id',
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM mcp_servers WHERE owner_id = ? AND id = ?'),
    };
    return {
        list(ownerId: string): McpServer[] {
            return q.list.all(ownerId).map(toServer);
        },
        /** 启动时:所有 owner 的已启用服务器。 */
        allEnabled(): (McpServer & { ownerId: string })[] {
            return q.all.all().map((r) => ({ ...toServer(r), ownerId: r.ownerId }));
        },
        get(ownerId: string, id: string): McpServer | null {
            const row = q.get.get(ownerId, id);
            return row ? toServer(row) : null;
        },
        create(
            ownerId: string,
            input: Omit<McpServer, 'id' | 'createdAt' | 'cwd'> & { cwd?: string | undefined },
        ): McpServer {
            const id = newId(now());
            q.insert.run({
                id,
                ownerId,
                name: input.name,
                command: input.command,
                args: JSON.stringify(input.args),
                cwd: input.cwd ?? null,
                env: JSON.stringify(input.envPassthrough),
                enabled: input.enabled ? 1 : 0,
                risks: JSON.stringify(input.toolRisks),
                at: now().toISOString(),
            });
            return toServer(q.get.get(ownerId, id)!);
        },
        update(ownerId: string, id: string, patch: { enabled?: boolean; toolRisks?: Record<string, ToolRisk> }) {
            const current = this.get(ownerId, id);
            if (!current) return null;
            q.update.run({
                id,
                enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
                risks: JSON.stringify(patch.toolRisks ?? current.toolRisks),
                at: now().toISOString(),
            });
            return this.get(ownerId, id);
        },
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
    };
}

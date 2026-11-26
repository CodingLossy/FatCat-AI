// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 模型配置档。只保存 env: / file: 形式的密钥引用,从不保存明文(ADR 0006)。
import type { ModelKind, ModelProfileInput, ModelPurpose, VoiceProtocol } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import { selectList } from './schema.js';

/** 与 shared 的 ModelProfile 相同,但不含运行时计算的 keyStatus。 */
export interface ModelProfileRecord {
    id: string;
    label: string;
    kind: ModelKind;
    baseURL?: string;
    apiKeyRef: string | null;
    model: string;
    purpose: ModelPurpose[];
    contextWindow?: number;
    params?: { temperature?: number; maxOutputTokens?: number; voice?: string; voiceProtocol?: VoiceProtocol };
    /** 支持图片输入(ADR 0020 第 1.2 节);false 时 API 中省略。 */
    vision?: boolean;
    /** 管理员共享给成员(ADR 0053 第 5.1 节)。 */
    shared: boolean;
    createdAt: string;
    updatedAt: string;
}

/** 别的账户共享来的配置档:多一个所属账户,调用方据此决定只读视图。 */
export interface UsableProfileRecord extends ModelProfileRecord {
    ownerId: string;
}

interface Row {
    id: string;
    ownerId: string;
    label: string;
    kind: ModelKind;
    baseUrl: string | null;
    apiKeyRef: string | null;
    model: string;
    purposeJson: string;
    contextWindow: number | null;
    paramsJson: string | null;
    vision: number;
    shared: number;
    createdAt: string;
    updatedAt: string;
}

function toRecord(row: Row): ModelProfileRecord {
    return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        ...(row.baseUrl === null ? {} : { baseURL: row.baseUrl }),
        apiKeyRef: row.apiKeyRef,
        model: row.model,
        purpose: JSON.parse(row.purposeJson) as ModelPurpose[],
        ...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
        ...(row.paramsJson === null ? {} : { params: JSON.parse(row.paramsJson) as ModelProfileRecord['params'] }),
        ...(row.vision === 1 ? { vision: true } : {}),
        shared: row.shared === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toParams(input: ModelProfileInput, ownerId: string, id: string, createdAt: string, updatedAt: string) {
    return {
        id,
        ownerId,
        label: input.label,
        kind: input.kind,
        baseUrl: input.baseURL ?? null,
        apiKeyRef: input.apiKeyRef,
        model: input.model,
        purposeJson: JSON.stringify(input.purpose),
        contextWindow: input.contextWindow ?? null,
        paramsJson: input.params === undefined ? null : JSON.stringify(input.params),
        vision: input.vision === true ? 1 : 0,
        shared: input.shared === true ? 1 : 0,
        createdAt,
        updatedAt,
    };
}

export function createProfileRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const select = `SELECT ${selectList('model_profiles')} FROM model_profiles`;
    const q = {
        insert: sqlite.prepare(
            `INSERT INTO model_profiles (id, owner_id, label, kind, base_url, api_key_ref, model, purpose_json,
                                         context_window, params_json, vision, shared, created_at, updated_at)
             VALUES (@id, @ownerId, @label, @kind, @baseUrl, @apiKeyRef, @model, @purposeJson,
                     @contextWindow, @paramsJson, @vision, @shared, @createdAt, @updatedAt)`,
        ),
        replace: sqlite.prepare(
            `UPDATE model_profiles SET label = @label, kind = @kind, base_url = @baseUrl, api_key_ref = @apiKeyRef,
                model = @model, purpose_json = @purposeJson, context_window = @contextWindow,
                params_json = @paramsJson, vision = @vision, shared = @shared, updated_at = @updatedAt
             WHERE owner_id = @ownerId AND id = @id`,
        ),
        get: sqlite.prepare<[string, string], Row>(`${select} WHERE owner_id = ? AND id = ?`),
        list: sqlite.prepare<[string], Row>(`${select} WHERE owner_id = ? ORDER BY created_at, id`),
        delete: sqlite.prepare('DELETE FROM model_profiles WHERE owner_id = ? AND id = ?'),
        ownerOf: sqlite.prepare<[string], { ownerId: string }>(
            'SELECT owner_id AS ownerId FROM model_profiles WHERE id = ?',
        ),
        // 自己的,加上未停用的管理员共享出来的(ADR 0053 第 5.1 节);自己的排在前面
        usable: sqlite.prepare<[string, string], Row>(
            `${select} WHERE owner_id = ?
                OR (shared = 1 AND owner_id <> ?
                    AND owner_id IN (SELECT id FROM owners WHERE role = 'admin' AND disabled_at IS NULL))
             ORDER BY created_at, id`,
        ),
    };
    const toUsable = (row: Row): UsableProfileRecord => ({ ...toRecord(row), ownerId: row.ownerId });

    return {
        create(ownerId: string, input: ModelProfileInput): ModelProfileRecord {
            const at = now().toISOString();
            const id = newId(now());
            q.insert.run(toParams(input, ownerId, id, at, at));
            return toRecord(q.get.get(ownerId, id)!);
        },
        get(ownerId: string, id: string): ModelProfileRecord | null {
            const row = q.get.get(ownerId, id);
            return row ? toRecord(row) : null;
        },
        list(ownerId: string): ModelProfileRecord[] {
            return q.list.all(ownerId).map(toRecord);
        },
        /** 整体替换(调用方先把 PATCH 与现有值合并并校验)。 */
        replace(ownerId: string, id: string, input: ModelProfileInput): ModelProfileRecord | null {
            const existing = q.get.get(ownerId, id);
            if (!existing) return null;
            q.replace.run(toParams(input, ownerId, id, existing.createdAt, now().toISOString()));
            return toRecord(q.get.get(ownerId, id)!);
        },
        /**
         * 这个账户能选用的配置档:自己的,加上未停用的管理员共享的(ADR 0053 第 5.1 节)。
         * 管理员降级、停用或取消共享后,别人立即选不到。
         */
        listUsable(ownerId: string): UsableProfileRecord[] {
            const rows = q.usable.all(ownerId, ownerId).map(toUsable);
            return [...rows.filter((r) => r.ownerId === ownerId), ...rows.filter((r) => r.ownerId !== ownerId)];
        },
        getUsable(ownerId: string, id: string): UsableProfileRecord | null {
            return this.listUsable(ownerId).find((p) => p.id === id) ?? null;
        },
        /** 配置档属于哪个账户(按账户检查密钥引用时用,ADR 0053 第 5 节);不存在时为 null。 */
        ownerOf(id: string): string | null {
            return q.ownerOf.get(id)?.ownerId ?? null;
        },
        /** 删除配置档;引用它的会话 model_profile_id 由外键置空。 */
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
    };
}

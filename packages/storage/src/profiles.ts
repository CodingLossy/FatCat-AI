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
    createdAt: string;
    updatedAt: string;
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
                                         context_window, params_json, vision, created_at, updated_at)
             VALUES (@id, @ownerId, @label, @kind, @baseUrl, @apiKeyRef, @model, @purposeJson,
                     @contextWindow, @paramsJson, @vision, @createdAt, @updatedAt)`,
        ),
        replace: sqlite.prepare(
            `UPDATE model_profiles SET label = @label, kind = @kind, base_url = @baseUrl, api_key_ref = @apiKeyRef,
                model = @model, purpose_json = @purposeJson, context_window = @contextWindow,
                params_json = @paramsJson, vision = @vision, updated_at = @updatedAt
             WHERE owner_id = @ownerId AND id = @id`,
        ),
        get: sqlite.prepare<[string, string], Row>(`${select} WHERE owner_id = ? AND id = ?`),
        list: sqlite.prepare<[string], Row>(`${select} WHERE owner_id = ? ORDER BY created_at, id`),
        delete: sqlite.prepare('DELETE FROM model_profiles WHERE owner_id = ? AND id = ?'),
    };

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
        /** 删除配置档;引用它的会话 model_profile_id 由外键置空。 */
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
    };
}

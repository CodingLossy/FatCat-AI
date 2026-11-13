// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 密钥加密存储的状态与迁移(ADR 0026,自 M5b 起提供)。接口永远不返回密钥或主密钥本身。
import { z } from 'zod';

export const SecretsFileState = z.enum(['none', 'plaintext', 'encrypted']);
export type SecretsFileState = z.infer<typeof SecretsFileState>;

export const MasterKeySource = z.enum(['env', 'env-file', 'data-dir', 'none']);
export type MasterKeySource = z.infer<typeof MasterKeySource>;

/** GET /api/v1/settings/secrets。 */
export const SecretsStatus = z.object({
    file: SecretsFileState,
    masterKeySource: MasterKeySource,
    /** 主密钥不可用(丢失或与加密文件不匹配)时依赖密钥的功能报「密钥不可用」,服务器照常启动。 */
    keyAvailable: z.boolean(),
    /** 主密钥的 SHA-256 哈希前 8 位十六进制;不可用时为 null。 */
    fingerprint: z
        .string()
        .regex(/^[0-9a-f]{8}$/)
        .nullable(),
    /** backups/ 里 secrets 备份的份数,以及其中仍为明文的份数。 */
    backups: z.object({ total: z.number().int().min(0), plaintext: z.number().int().min(0) }),
});
export type SecretsStatus = z.infer<typeof SecretsStatus>;

/** 迁移时对已有明文备份的处理;默认 keep,不删任何东西。 */
export const PlaintextBackupAction = z.enum(['keep', 'encrypt', 'delete']);
export type PlaintextBackupAction = z.infer<typeof PlaintextBackupAction>;

/** POST /api/v1/settings/secrets/migrate:必须显式 confirm。 */
export const SecretsMigrateRequest = z.object({
    confirm: z.literal(true),
    plaintextBackups: PlaintextBackupAction.default('keep'),
});
export type SecretsMigrateRequest = z.input<typeof SecretsMigrateRequest>;

export const SecretsMigrateResponse = z.object({
    migratedKeys: z.number().int().min(0),
    /** 迁移前创建的备份文件名(位于 backups/)。 */
    backup: z.string().min(1).max(200),
    fingerprint: SecretsStatus.shape.fingerprint,
    plaintextBackups: z.object({
        kept: z.number().int().min(0),
        encrypted: z.number().int().min(0),
        deleted: z.number().int().min(0),
    }),
});
export type SecretsMigrateResponse = z.infer<typeof SecretsMigrateResponse>;

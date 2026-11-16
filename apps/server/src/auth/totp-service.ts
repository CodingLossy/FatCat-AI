// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { decryptSecrets, encryptSecrets, type MasterKeyResolver } from '@fatcat-ai/providers';
import type { Repositories, TotpCredentialRecord } from '@fatcat-ai/storage';
import { ApiError } from '../errors.js';
import {
    generateRecoveryCodes,
    hashRecoveryCode,
    newRecoverySalt,
    normalizeRecoveryCode,
    recoveryCodeMatches,
    verifyTotp,
} from './totp.js';

/** 主密钥不可用:启用与验证都失败,绝不放行(ADR 0027 第 4 节)。 */
export const keyUnavailable = () =>
    new ApiError(
        503,
        'internal',
        'Service Unavailable',
        '密钥不可用: the master key is not available, so TOTP cannot be used.',
    );

export interface SecondFactor {
    code?: string | undefined;
    recoveryCode?: string | undefined;
}

export interface TotpServiceDeps {
    repos: Repositories;
    masterKey: MasterKeyResolver | undefined;
    now: () => Date;
}

/** 共享密钥的加解密、验证码与恢复码的校验。校验与核销全部同步完成,中间没有 await,所以并发提交不会都成功。 */
export class TotpService {
    constructor(private readonly deps: TotpServiceDeps) {}

    /** 取主密钥;没有、格式不对或读不出都报「密钥不可用」。 */
    private resolveKey(get: () => Buffer | null | undefined): Buffer {
        let key: Buffer | null | undefined;
        try {
            key = get();
        } catch {
            key = null;
        }
        if (!key) throw keyUnavailable();
        return key;
    }

    /** 加密一个新的共享密钥。没有任何主密钥来源时按 ADR 0026 创建 master.key;仍不可用则报错。 */
    encryptNewSecret(secretBase32: string): string {
        const key = this.resolveKey(() => this.deps.masterKey?.ensure().key);
        return encryptSecrets(secretBase32, key);
    }

    /** 解密库里的共享密钥;主密钥缺失、不对或信封损坏都报「密钥不可用」。 */
    decryptSecret(credential: TotpCredentialRecord): string {
        const key = this.resolveKey(() => this.deps.masterKey?.current().key);
        try {
            return decryptSecrets(credential.secretEnc, key);
        } catch {
            throw keyUnavailable();
        }
    }

    /** 只校验验证码,返回匹配的步长(不核销);启用时用。 */
    stepFor(credential: TotpCredentialRecord, code: string): number | null {
        return verifyTotp(this.decryptSecret(credential), code, this.deps.now().getTime());
    }

    /** 验证码是否有效且步长未用过;有效则当场记下步长(重放保护)。同步,无 await。 */
    checkCode(credential: TotpCredentialRecord, code: string): boolean {
        const secret = this.decryptSecret(credential);
        const step = verifyTotp(secret, code, this.deps.now().getTime());
        if (step === null) return false;
        return this.deps.repos.totp.consumeStep(credential.ownerId, step);
    }

    /** 恢复码是否匹配某个未用的码;匹配则核销。每个未用的码都比较一遍再决定,不提前返回。 */
    checkRecoveryCode(ownerId: string, recoveryCode: string): boolean {
        const normalized = normalizeRecoveryCode(recoveryCode);
        let matchedId: string | null = null;
        for (const row of this.deps.repos.totp.unusedRecoveryCodes(ownerId)) {
            if (recoveryCodeMatches(normalized, row.salt, row.codeHash) && matchedId === null) matchedId = row.id;
        }
        return matchedId !== null && this.deps.repos.totp.useRecoveryCode(ownerId, matchedId);
    }

    /** code 或 recoveryCode 任一有效即通过第二因素。 */
    checkSecondFactor(credential: TotpCredentialRecord, factor: SecondFactor): boolean {
        if (factor.code !== undefined) return this.checkCode(credential, factor.code);
        if (factor.recoveryCode !== undefined) return this.checkRecoveryCode(credential.ownerId, factor.recoveryCode);
        return false;
    }

    /** 生成 10 个恢复码:明文只返回给调用方,库里存加盐哈希。 */
    newRecoveryCodes(): { plain: string[]; hashes: { salt: string; codeHash: string }[] } {
        const plain = generateRecoveryCodes();
        const hashes = plain.map((code) => {
            const salt = newRecoverySalt();
            return { salt, codeHash: hashRecoveryCode(code, salt) };
        });
        return { plain, hashes };
    }
}

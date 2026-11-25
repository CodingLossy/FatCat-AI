// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理(ADR 0053 第 2、6 节,自 2.0 起提供):管理员发邀请码与重置码,改角色、停用、删除账户。
import { z } from 'zod';
import { AccountRole, Password, Username } from './auth.js';
import { Id, IsoDateTime } from './common.js';

export const DisplayName = z.string().trim().min(1).max(40);

/** 管理员看到的账户:只有账户本身的信息,看不到成员的任何数据(ADR 0053 第 2 节)。 */
export const Account = z.object({
    id: Id,
    username: Username,
    displayName: z.string().nullable(),
    role: AccountRole,
    disabled: z.boolean(),
    totpEnabled: z.boolean(),
    createdAt: IsoDateTime,
    /**
     * 磁盘用量(ADR 0053 第 8 节):附件文件和知识库索引里保存的文本,单位字节。只在账户列表里给出;
     * 2.0 不做硬配额。
     */
    usage: z.object({ attachmentBytes: z.number().int().min(0), knowledgeBytes: z.number().int().min(0) }).optional(),
});
export type Account = z.infer<typeof Account>;

export const AccountList = z.object({ accounts: z.array(Account) });
export type AccountList = z.infer<typeof AccountList>;

/** 一次性码:明文只在这一次响应里出现;24 小时有效。 */
export const CreatedAccountCode = z.object({
    kind: z.enum(['invite', 'reset']),
    code: z.string(),
    expiresAt: IsoDateTime,
});
export type CreatedAccountCode = z.infer<typeof CreatedAccountCode>;

/** 管理员改账户;至少带一个字段。不能改自己的角色和停用状态(避免把自己锁在外面)。 */
export const UpdateAccountRequest = z
    .object({
        role: AccountRole.optional(),
        disabled: z.boolean().optional(),
        displayName: DisplayName.nullable().optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

/** 删除要输入那个账户的用户名确认。 */
export const DeleteAccountRequest = z.object({ confirmUsername: Username }).strict();
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

/** 用邀请码建自己的账户(公开端点,有限速)。 */
export const AcceptInviteRequest = z
    .object({
        code: z.string().min(6).max(32),
        username: Username,
        password: Password,
        displayName: DisplayName.optional(),
    })
    .strict();
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

/** 用重置码设新密码(公开端点,有限速);成功后这个账户的会话、令牌和设备全部作废。 */
export const ResetPasswordRequest = z
    .object({
        code: z.string().min(6).max(32),
        password: Password,
    })
    .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

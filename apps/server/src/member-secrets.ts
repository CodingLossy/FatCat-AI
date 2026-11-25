// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 成员的密钥(ADR 0053 第 5 节):secrets.yaml 整个安装只有一份,成员写入的键都带前缀 `U<ownerId>_`,
// 管理员的不带前缀(和 1.0 一样)。成员保存密钥引用(模型配置档的 apiKeyRef、邮箱的 passwordRef)时:
// `env:` 只有管理员能用(环境变量是服务器的);`file:NAME` 自动换成 `file:U<ownerId>_NAME`;
// 指向别的账户前缀的引用一律拒绝。管理员也不能引用成员前缀的键(管理员看不到成员的数据)。
// 引用在保存时检查,存进库里的就是检查过的;解析时不用再带账户。
import type { Repositories } from '@fatcat-ai/storage';
import { isActiveAdmin as isAdmin } from './auth/middleware.js';
import { ApiError } from './errors.js';

/** 成员写入 secrets.yaml 的键都带这个前缀。 */
export const memberSecretPrefix = (ownerId: string) => `U${ownerId}_`;

/** 任何账户的成员前缀(U + ULID + _)。 */
export const MEMBER_KEY = /^U[0-9A-HJKMNP-TV-Z]{26}_/;

/** 渠道自己管理的键(微信登录令牌、QQ 的 AppSecret):只能由渠道写入和删除,不能通过密钥接口改。 */
export const CHANNEL_KEY = /^(ILINK_TOKEN_|QQBOT_SECRET_)/;

/** 键名的格式与引用的 `NAME` 一样(ADR 0006),最长 64 个字符。 */
export const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const invalid = (field: string, message: string) =>
    new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
        issues: [{ path: [field], message }],
    });

/**
 * 这个账户在 secrets.yaml 里实际使用的键名:管理员原样,成员加前缀。名字不合法或超长时抛 400。
 * `name` 是用户看到的名字(成员看不到前缀)。
 */
export function storedKeyName(repos: Pick<Repositories, 'owners'>, ownerId: string, name: string, field = 'name') {
    if (!KEY_NAME.test(name)) throw invalid(field, 'must be letters, digits or "_", starting with a letter or "_"');
    if (MEMBER_KEY.test(name) || CHANNEL_KEY.test(name)) throw invalid(field, 'this name is reserved');
    const stored = isAdmin(repos, ownerId) ? name : `${memberSecretPrefix(ownerId)}${name}`;
    if (stored.length > 64) throw invalid(field, `must be at most ${64 - (stored.length - name.length)} characters`);
    return stored;
}

/** 用户看到的键名:成员去掉自己的前缀。 */
export function visibleKeyName(ownerId: string, stored: string): string {
    const prefix = memberSecretPrefix(ownerId);
    return stored.startsWith(prefix) ? stored.slice(prefix.length) : stored;
}

/**
 * 检查并换算要保存的密钥引用。`null` / `undefined` 原样返回。
 * 已经带着自己前缀的引用(例如把读回来的值原样 PATCH 回去)保持不变。
 */
export function scopeSecretRef<T extends string | null | undefined>(
    repos: Pick<Repositories, 'owners'>,
    ownerId: string,
    ref: T,
    field: string,
): T {
    if (ref === null || ref === undefined) return ref;
    const [scheme, name = ''] = ref.split(':', 2) as [string, string | undefined];
    const admin = isAdmin(repos, ownerId);
    if (scheme === 'env') {
        if (!admin) {
            throw new ApiError(
                403,
                'admin_required',
                'Forbidden',
                'env: references read the server environment; only an admin can use them. Use file:NAME with a key you saved under Settings → Secrets.',
            );
        }
        return ref;
    }
    const own = memberSecretPrefix(ownerId);
    if (name.startsWith(own) && !admin) return ref;
    if (MEMBER_KEY.test(name)) throw invalid(field, "cannot refer to another account's key");
    if (CHANNEL_KEY.test(name)) throw invalid(field, 'channel keys cannot be referenced');
    return `file:${storedKeyName(repos, ownerId, name, field)}` as T;
}

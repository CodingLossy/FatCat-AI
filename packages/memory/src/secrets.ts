// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 凭据检测(《记忆模块补充设计》第 3 节第 2 条):命中即拒存。纯函数、纯本地规则、不依赖任何包,
// 记忆以外的地方(日志、审批卡片、导入)也可以直接用 `@fatcat-ai/memory/secrets` 引入。
// 规则由本项目自行编写;只返回命中类型,从不返回或记录命中的原文。

export type CredentialKind =
    | 'api_key'
    | 'access_token'
    | 'jwt'
    | 'private_key'
    | 'password_assignment'
    | 'url_credentials'
    | 'totp_seed'
    | 'high_entropy';

/** 赋值号:is / = / : / 是 / 为,前后可以有空白。 */
const ASSIGN = String.raw`\s*(?:is|=|:|：|是|为)\s*`;

/** 看起来不像值、而是在描述密码的常见英文词(避免「password is required」之类误报)。 */
const NOT_A_VALUE = String.raw`(?!(?:required|incorrect|wrong|invalid|missing|expired|reset|correct|strong|weak|too|not|the|a|an|my|your|same|changed|empty|optional)\b)`;

/** 密码类词:与赋值号之间允许少量文字,值必须是 ASCII(「密码学是一门学科」不会命中)。 */
const PASSWORD_WORDS = String.raw`(?:\b(?:password|passwd|pwd|passcode|pin(?:\s*code)?)\b|密码|口令)`;
/** 紧跟在密码类词后面、说明这是在谈论密码而不是给出密码的词(「密码管理器用的是 Bitwarden」)。 */
const NOT_THE_PASSWORD = String.raw`(?!\s*(?:学|管理|策略|规则|强度|长度|体制|算法|输入框|提示|格式|(?:manager|policy|policies|rules?|strength|length|hint|field|reset)\b))`;

/** 令牌类词:紧跟赋值号,值至少 8 位且同时含字母与数字(「max token = 4096」「secret: santa」不会命中)。 */
const TOKEN_WORDS = String.raw`(?:\b(?:token|secret|api[\s_-]?key|access[\s_-]?key|client[\s_-]?secret)\b|密钥|秘钥|令牌)`;
const TOKEN_VALUE = String.raw`(?=[\w\-./+=]*\d)(?=[\w\-./+=]*[A-Za-z])[\w\-./+=]{8,}`;

const PATTERNS: readonly [CredentialKind, RegExp][] = [
    ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
    // 常见密钥前缀:OpenAI / Anthropic 等的 sk-、Stripe 的 sk_live_ / rk_live_、Google、AWS、Hugging Face
    ['api_key', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['api_key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
    ['api_key', /\bAIza[A-Za-z0-9_-]{30,}/],
    ['api_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['api_key', /\bhf_[A-Za-z0-9]{30,}/],
    // 访问令牌:GitHub、GitLab、Slack、本项目的 aip_pat_、HTTP Bearer
    [
        'access_token',
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|aip_pat_[A-Za-z0-9_-]{20,})/,
    ],
    ['access_token', /\bxox[abpsr]-[A-Za-z0-9-]{10,}/],
    ['access_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    // URL 里的用户名与密码:postgres://user:pass@host
    ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i],
    // TOTP 种子:otpauth:// URI;「两步验证 / 2FA / TOTP」附近的 Base32 串见 hasTotpSeed
    ['totp_seed', /otpauth:\/\/[th]otp\//i],
    // 「密码是 xxx」「我的 Gmail 密码:xxx」「password for the router is xxx」
    [
        'password_assignment',
        new RegExp(
            `${PASSWORD_WORDS}${NOT_THE_PASSWORD}[^\\n。.;；,，]{0,20}?${ASSIGN}${NOT_A_VALUE}[\\x21-\\x7e]{4,}`,
            'i',
        ),
    ],
    // 「token=xxx」「secret: xxx」「api key 是 xxx」
    ['password_assignment', new RegExp(`${TOKEN_WORDS}${ASSIGN}${TOKEN_VALUE}`, 'i')],
];

/** 香农熵(比特 / 字符)。 */
export function shannonEntropy(s: string): number {
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    for (const n of counts.values()) {
        const p = n / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_MIN_BITS = 4.0;

/**
 * 长度 ≥ 20、同时含字母与数字、熵 ≥ 4.0 的连续串视为疑似密钥。
 * URL 不参与(其中的密钥由前缀规则与 url_credentials 规则负责),否则普通链接也会被拒。
 */
function hasHighEntropyToken(text: string): boolean {
    for (const token of text.split(/[\s"'`,;()[\]{}<>，。；：（）、「」《》]+/)) {
        if (token.length < HIGH_ENTROPY_MIN_LENGTH || token.includes('://')) continue;
        if (/[A-Za-z]/.test(token) && /\d/.test(token) && shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS) return true;
    }
    return false;
}

const TOTP_HINT = /totp|2fa|mfa|\botp\b|两步验证|二次验证|双重验证|谷歌验证器|身份验证器|authenticator/gi;
/** Base32 种子:至少 16 个大写字母或 2–7(含至少一个数字),可按 4 个一组用空格或连字符分开。 */
const BASE32_SEED = /\b(?=[A-Z2-7\s-]*[2-7])(?:[A-Z2-7]{4}[\s-]?){3}[A-Z2-7]{4,}\b/;
const TOTP_WINDOW = 60;

/** 两步验证相关的词之后 60 个字符内出现 Base32 种子(大小写敏感,避免把长英文单词当成种子)。 */
function hasTotpSeed(text: string): boolean {
    for (const hint of text.matchAll(TOTP_HINT)) {
        const start = hint.index + hint[0].length;
        if (BASE32_SEED.test(text.slice(start, start + TOTP_WINDOW))) return true;
    }
    return false;
}

/** 返回检测到的凭据类型;未检测到时返回 null。 */
export function detectCredential(text: string): CredentialKind | null {
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
    if (hasTotpSeed(text)) return 'totp_seed';
    return hasHighEntropyToken(text) ? 'high_entropy' : null;
}

/** 替换凭据时使用的占位文字。 */
export const CREDENTIAL_PLACEHOLDER = '[已隐藏凭据]';

/**
 * 把文本中能定位的凭据替换为占位文字(知识库入库前使用,ADR 0015 第 7 节);返回替换后的文本与替换次数。
 * 规则与 detectCredential 相同;替换后仍能检测到凭据时,调用方应整段拦截。
 */
export function redactCredentials(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    for (const [, pattern] of PATTERNS) {
        const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        out = out.replace(global, () => {
            count++;
            return CREDENTIAL_PLACEHOLDER;
        });
    }
    for (const hint of [...out.matchAll(TOTP_HINT)].reverse()) {
        const start = hint.index + hint[0].length;
        const window = out.slice(start, start + TOTP_WINDOW);
        const seed = BASE32_SEED.exec(window);
        if (!seed) continue;
        const at = start + seed.index;
        out = `${out.slice(0, at)}${CREDENTIAL_PLACEHOLDER}${out.slice(at + seed[0].length)}`;
        count++;
    }
    out = out.replace(/[^\s"'`,;()[\]{}<>，。；：（）、「」《》]{20,}/g, (token) => {
        if (token.includes('://') || !/[A-Za-z]/.test(token) || !/\d/.test(token)) return token;
        if (shannonEntropy(token) < HIGH_ENTROPY_MIN_BITS) return token;
        count++;
        return CREDENTIAL_PLACEHOLDER;
    });
    return { text: out, count };
}

/** 检测任意 JSON 值(键与值都查)。 */
export function detectCredentialIn(value: unknown): CredentialKind | null {
    if (value === null || value === undefined) return null;
    return detectCredential(typeof value === 'string' ? value : JSON.stringify(value));
}

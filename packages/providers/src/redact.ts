// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

export const REDACTED = '[REDACTED]';

/** 常见密钥形态;即使不是本进程加载的密钥,出现在日志或错误里也一律替换(ADR 0006 第 3 节)。 */
const SECRET_PATTERNS: readonly RegExp[] = [
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bsk-[A-Za-z0-9_-]{8,}/g,
    /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    /\bghp_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\baip_pat_[A-Za-z0-9_-]{20,}/g,
    /\bAIza[A-Za-z0-9_-]{30,}/g,
    /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 短于此长度的值不登记,避免把常见单词当密钥全局替换。 */
const MIN_SECRET_LENGTH = 8;

/**
 * 脱敏器:登记本进程实际加载过的密钥值,并按常见形态替换。
 * 日志、上游错误、录制的 fixture 在输出前都经过它。
 */
export class Redactor {
    private readonly secrets = new Set<string>();

    add(secret: string | null | undefined): void {
        if (secret && secret.length >= MIN_SECRET_LENGTH) this.secrets.add(secret);
    }

    redact(text: string): string {
        let out = text;
        // 先替换长的,避免一个密钥是另一个的前缀时只替换一半
        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
            out = out.split(secret).join(REDACTED);
        }
        for (const pattern of SECRET_PATTERNS) {
            out = out.replace(pattern, (match, scheme?: string) =>
                typeof scheme === 'string' && /^(Bearer|Basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED,
            );
        }
        return out;
    }
}

/** 上游错误正文:脱敏并截断到 500 字符。 */
export function sanitizeUpstreamText(redactor: Redactor, text: string, max = 500): string {
    const clean = redactor.redact(text).replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

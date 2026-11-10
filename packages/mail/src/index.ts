// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件(ADR 0016)。本入口不导入任何网络库:IMAP / SMTP / 解析只在 worker 中加载(见 run.ts)。
export { appendsToSent, MAIL_PRESETS, planSentCopy, serverSavesSent, type SentCopyPlan } from './presets.js';
export { JOB_TIMEOUT_MS, MailJobError, runInWorker } from './run.js';
export type { MailJob, MailJobResult, MailJobRunner } from './run.js';
export { DEFAULT_BATCH_SIZE, pickFolders, syncAccountWith } from './sync.js';
export { normalizeSubject, ownThreadKey, referenceKey, subjectKey } from './thread.js';
export type * from './types.js';
export { createMailTools, fullText, MAX_READ_CHARS, startOfToday, type MailToolOptions } from './tools.js';
export { MAIL_ROOT_REF, mailProvider } from './items.js';
export { addAttachmentToKb, AttachmentError, type AttachmentKbDeps } from './attachments.js';

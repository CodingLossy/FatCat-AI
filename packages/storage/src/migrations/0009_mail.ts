// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 邮件(ADR 0016,M3 PR 2):账户只存密码引用;邮件按 Message-ID 在账户内去重,
 * 出现在哪些文件夹记在 mail_message_folders;正文的全文检索用单独的 mail_fts(trigram)。
 * sessions.untrusted_at 记录会话第一次读到不可信内容的时间(ADR 0016 第 7 节,PR 3 起使用)。
 * mail_messages 用整数主键 seq 作为 mail_fts 的 rowid(隐式 rowid 在 VACUUM 时可能改变)。
 * 已发布的迁移不得修改。
 */
export const migration0009: Migration = {
    id: 9,
    name: 'mail',
    sql: /* sql */ `
CREATE TABLE mail_accounts (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  label                  TEXT NOT NULL,
  address                TEXT NOT NULL,
  username               TEXT NOT NULL,
  password_ref           TEXT NOT NULL,
  imap_json              TEXT NOT NULL,
  smtp_json              TEXT NOT NULL,
  initial_sync_days      INTEGER NOT NULL,
  sync_interval_minutes  INTEGER NOT NULL,
  append_to_sent         INTEGER NOT NULL CHECK (append_to_sent IN (0, 1)),
  enabled                INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  last_synced_at         TEXT,
  last_error             TEXT,
  failures               INTEGER NOT NULL DEFAULT 0,
  next_sync_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_mail_accounts_owner ON mail_accounts(owner_id);

CREATE TABLE mail_folders (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,
  special_use     TEXT,
  uid_validity    INTEGER,
  last_uid        INTEGER NOT NULL DEFAULT 0,
  highest_modseq  TEXT,
  last_synced_at  TEXT,
  UNIQUE (account_id, path)
);

CREATE TABLE mail_messages (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  account_id       TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id       TEXT,
  in_reply_to      TEXT,
  references_json  TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  from_json        TEXT,
  reply_to_json    TEXT NOT NULL,
  to_json          TEXT NOT NULL,
  cc_json          TEXT NOT NULL,
  subject          TEXT NOT NULL,
  date             TEXT NOT NULL,
  unread           INTEGER NOT NULL CHECK (unread IN (0, 1)),
  body             TEXT NOT NULL,
  snippet          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (account_id, message_id)
);
CREATE INDEX idx_mail_messages_thread ON mail_messages(account_id, thread_key);
CREATE INDEX idx_mail_messages_date ON mail_messages(account_id, date);
CREATE INDEX idx_mail_messages_reply ON mail_messages(account_id, in_reply_to);

CREATE TABLE mail_message_folders (
  folder_id   TEXT NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  uid         INTEGER NOT NULL,
  message_id  TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, uid)
);
CREATE INDEX idx_mail_message_folders_message ON mail_message_folders(message_id);

CREATE TABLE mail_attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  part          TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  downloaded    INTEGER NOT NULL DEFAULT 0 CHECK (downloaded IN (0, 1))
);
CREATE INDEX idx_mail_attachments_message ON mail_attachments(message_id);

CREATE TABLE mail_drafts (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  to_json              TEXT NOT NULL,
  cc_json              TEXT NOT NULL,
  subject              TEXT NOT NULL,
  body                 TEXT NOT NULL,
  reply_to_message_id  TEXT REFERENCES mail_messages(id) ON DELETE SET NULL,
  attachments_json     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE VIRTUAL TABLE mail_fts USING fts5(
  subject, body,
  content = 'mail_messages', content_rowid = 'seq',
  tokenize = 'trigram'
);
CREATE TRIGGER trg_mail_fts_ai AFTER INSERT ON mail_messages BEGIN
  INSERT INTO mail_fts(rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;
CREATE TRIGGER trg_mail_fts_ad AFTER DELETE ON mail_messages BEGIN
  INSERT INTO mail_fts(mail_fts, rowid, subject, body) VALUES ('delete', old.seq, old.subject, old.body);
END;

ALTER TABLE sessions ADD COLUMN untrusted_at TEXT;
`,
};

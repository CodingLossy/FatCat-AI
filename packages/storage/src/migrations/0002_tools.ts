// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 工具框架与审批(ADR 0010):持久化的审批请求、预授权、审计日志。
 * 已发布的迁移不得修改;新的结构变更请新增迁移文件。
 */
export const migration0002: Migration = {
    id: 2,
    name: 'tools',
    sql: /* sql */ `
-- 审批请求:重启后 pending 的请求一律标为 expired;只有第一个决定生效(WHERE status = 'pending')
CREATE TABLE approval_requests (
  call_id         TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  risk            TEXT NOT NULL CHECK (risk IN ('read','write','external','dangerous')),
  summary         TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  preauthorizable INTEGER NOT NULL CHECK (preauthorizable IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX idx_approval_requests_owner ON approval_requests(owner_id, status, created_at);

-- 预授权:session 范围的随会话删除;external / dangerous 不允许预授权(由代码保证)
CREATE TABLE tool_preauth (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('session','always')),
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  constraint_json TEXT,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  CHECK ((scope = 'session') = (session_id IS NOT NULL))
);
CREATE INDEX idx_tool_preauth_lookup ON tool_preauth(owner_id, tool_name);

-- 审计日志:会话删除后仍保留,所以运行 / 会话 id 不加外键;只存脱敏后的入参摘要
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('tool-call','preauth-created','preauth-revoked','memory-undo')),
  tool_name    TEXT,
  risk         TEXT CHECK (risk IS NULL OR risk IN ('read','write','external','dangerous')),
  call_id      TEXT,
  run_id       TEXT,
  session_id   TEXT,
  decision     TEXT CHECK (decision IS NULL OR decision IN
               ('auto','preauthorized','conditional','approved','rejected','expired','cancelled','denied')),
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','error','not_run')),
  summary      TEXT NOT NULL,
  input_digest TEXT CHECK (input_digest IS NULL OR length(input_digest) <= 500),
  error        TEXT
);
CREATE INDEX idx_audit_owner_at ON audit_log(owner_id, at, id);
`,
};

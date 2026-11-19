// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 增量同步的变更日志(ADR 0045 第 2 节):新增 change_log 表和一组触发器,不改任何已有表和已有数据。
 * 每个实体(会话、消息、条目)只保留最近一次变化的一行(触发器先删旧行再插入,seq 自增、只增不减),
 * 所以表的大小不超过实体数量,不会随流式更新膨胀;删除记为墓碑(deleted = 1)。
 * 触发器覆盖所有写入路径(含外键级联删除),所以各处仓储代码不用逐个改。
 * 迁移时把已有数据回填一遍(按 updated_at 排序),新设备第一次同步就能拿到完整内容。
 * 回滚:旧版本不能直接打开已迁移的库(unknown to this version)。唯一办法是停服务,
 * 用 backups/ 里的 db-…-pre-0021.sqlite 恢复再运行旧版本;备份之后写入的数据会丢失。
 * 想在新版本里丢掉这个功能只需 DROP 触发器和 change_log,其余数据不受影响。
 */
export const migration0021: Migration = {
    id: 21,
    name: 'change_log',
    sql: /* sql */ `
CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('session','message','item')),
  entity_id  TEXT NOT NULL,
  session_id TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  changed_at TEXT NOT NULL,
  UNIQUE (kind, entity_id)
);
CREATE INDEX idx_change_log_owner_seq ON change_log(owner_id, seq);

-- 回填
INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  SELECT owner_id, 'session', id, NULL, 0, updated_at FROM sessions ORDER BY updated_at, id;
INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  SELECT owner_id, 'item', id, NULL, deleted_at IS NOT NULL, updated_at FROM items ORDER BY updated_at, id;
INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  SELECT owner_id, 'message', id, session_id, 0, updated_at FROM messages ORDER BY updated_at, id;

-- 会话
CREATE TRIGGER trg_change_sessions_ins AFTER INSERT ON sessions BEGIN
  DELETE FROM change_log WHERE kind = 'session' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'session', NEW.id, NULL, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_change_sessions_upd AFTER UPDATE ON sessions BEGIN
  DELETE FROM change_log WHERE kind = 'session' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'session', NEW.id, NULL, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_change_sessions_del AFTER DELETE ON sessions BEGIN
  DELETE FROM change_log WHERE kind = 'session' AND entity_id = OLD.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (OLD.owner_id, 'session', OLD.id, NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- 运行开始 / 结束会改变会话的 running 状态,会话本身的行不一定变
CREATE TRIGGER trg_change_runs_ins AFTER INSERT ON runs BEGIN
  DELETE FROM change_log WHERE kind = 'session' AND entity_id = NEW.session_id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  SELECT s.owner_id, 'session', s.id, NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sessions s WHERE s.id = NEW.session_id;
END;
CREATE TRIGGER trg_change_runs_upd AFTER UPDATE OF finished_at ON runs BEGIN
  DELETE FROM change_log WHERE kind = 'session' AND entity_id = NEW.session_id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  SELECT s.owner_id, 'session', s.id, NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sessions s WHERE s.id = NEW.session_id;
END;

-- 消息
CREATE TRIGGER trg_change_messages_ins AFTER INSERT ON messages BEGIN
  DELETE FROM change_log WHERE kind = 'message' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'message', NEW.id, NEW.session_id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_change_messages_upd AFTER UPDATE ON messages BEGIN
  DELETE FROM change_log WHERE kind = 'message' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'message', NEW.id, NEW.session_id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_change_messages_del AFTER DELETE ON messages BEGIN
  DELETE FROM change_log WHERE kind = 'message' AND entity_id = OLD.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (OLD.owner_id, 'message', OLD.id, OLD.session_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- 条目(软删除 deleted_at 也记为墓碑)
CREATE TRIGGER trg_change_items_ins AFTER INSERT ON items BEGIN
  DELETE FROM change_log WHERE kind = 'item' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'item', NEW.id, NULL, NEW.deleted_at IS NOT NULL, NEW.updated_at);
END;
CREATE TRIGGER trg_change_items_upd AFTER UPDATE ON items BEGIN
  DELETE FROM change_log WHERE kind = 'item' AND entity_id = NEW.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (NEW.owner_id, 'item', NEW.id, NULL, NEW.deleted_at IS NOT NULL, NEW.updated_at);
END;
CREATE TRIGGER trg_change_items_del AFTER DELETE ON items BEGIN
  DELETE FROM change_log WHERE kind = 'item' AND entity_id = OLD.id;
  INSERT INTO change_log (owner_id, kind, entity_id, session_id, deleted, changed_at)
  VALUES (OLD.owner_id, 'item', OLD.id, NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`,
};

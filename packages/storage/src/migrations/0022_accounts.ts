// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 多用户的账户字段(ADR 0053 第 2、10 节):`owners` 加角色、显示名与停用时间,已有的主人设为管理员;
 * 去掉 1.0 的「只能有一个主人」触发器,换成「至少保留一个未停用的管理员」:
 * - 第一个账户总是管理员(还没有未停用的管理员时,插入的行自动设为 admin);插入之后仍然没有未停用的管理员
 *   (例如往空表插一行已停用的账户,或 INSERT OR REPLACE 把唯一的管理员换成已停用的行)就中止;
 * - 不能把最后一个未停用的管理员降级、停用或删除。
 * 不改写任何其他表的数据。建第二个账户的接口在下一个 PR(邀请码),本迁移之后仍然只有 setup 能建账户。
 * 回滚:旧版本不认识这个迁移会拒绝启动;停服务后用 backups/ 里的 db-…-pre-0022.sqlite 恢复。
 */
export const migration0022: Migration = {
    id: 22,
    name: 'accounts',
    sql: /* sql */ `
ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'));
ALTER TABLE owners ADD COLUMN display_name TEXT;
ALTER TABLE owners ADD COLUMN disabled_at TEXT;
UPDATE owners SET role = 'admin';

DROP TRIGGER trg_owners_single;

CREATE TRIGGER trg_owners_first_admin AFTER INSERT ON owners
  WHEN (SELECT count(*) FROM owners WHERE role = 'admin' AND disabled_at IS NULL) = 0
BEGIN
  UPDATE owners SET role = 'admin' WHERE id = NEW.id AND NEW.disabled_at IS NULL;
  SELECT RAISE(ABORT, 'at least one active admin is required')
   WHERE (SELECT count(*) FROM owners WHERE role = 'admin' AND disabled_at IS NULL) = 0;
END;

CREATE TRIGGER trg_owners_last_admin_update BEFORE UPDATE OF role, disabled_at ON owners
  WHEN OLD.role = 'admin' AND OLD.disabled_at IS NULL
   AND (NEW.role <> 'admin' OR NEW.disabled_at IS NOT NULL)
   AND (SELECT count(*) FROM owners WHERE role = 'admin' AND disabled_at IS NULL AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'at least one active admin is required');
END;

CREATE TRIGGER trg_owners_last_admin_delete BEFORE DELETE ON owners
  WHEN OLD.role = 'admin' AND OLD.disabled_at IS NULL
   AND (SELECT count(*) FROM owners WHERE role = 'admin' AND disabled_at IS NULL AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'at least one active admin is required');
END;
`,
};

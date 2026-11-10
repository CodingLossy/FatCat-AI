# AGENTS.md · 给 AI 编码代理(Claude Code 等)的工作约定

本文件是仓库内 AI 代理与人类贡献者共同遵守的约定,内容来自开发计划第 13 节。开发总纲见 [docs/plan/AI-Personal-开发计划.md](docs/plan/AI-Personal-开发计划.md);**第 16 节「已定决策」不得自行更改**。

## 项目一句话

可自托管的开源个人 AI 助手框架。headless 核心(`apps/server`)只通过版本化的 `/api/v1` HTTP + WebSocket API 对外;Web UI、CLI、IM 渠道、以后的桌面与移动端都只是它的客户端。

## 常用命令

| 命令                                                                  | 作用                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm install`                                                        | 安装依赖(Node 24 LTS 或更高;pnpm 10)                             |
| `pnpm dev`                                                            | 同时启动 server(127.0.0.1:8787)与 web(127.0.0.1:5173)            |
| `pnpm build`                                                          | 构建全部包(Turborepo)                                            |
| `pnpm lint` / `pnpm typecheck` / `pnpm test`                          | ESLint / tsc / Vitest                                            |
| `pnpm format` / `pnpm format:check`                                   | Prettier                                                         |
| `pnpm check:spdx` / `pnpm check:licenses` / `pnpm check:placeholders` | 许可证头、依赖白名单、占位符残留                                 |
| `pnpm --filter @ai-personal/server test`                              | 只跑某个包                                                       |
| `pnpm test:e2e` / `pnpm eval`                                         | Playwright 冒烟 / 记忆评测(召回率、过时率、错误率)与邮件注入评测 |
| `docker compose -f docker/docker-compose.yml up --build`              | 本地容器运行                                                     |

以后加入:`pnpm --filter desktop tauri build`。

## 目录约定

- `apps/server` 核心服务(Hono);`apps/web` React Web UI;`apps/cli`、`apps/docs`、`apps/desktop` 为后续里程碑预留。
- `packages/shared` 协议 schema 与类型(zod,**Apache-2.0**);`packages/plugin-sdk`、`packages/client` 为 **Apache-2.0** SDK;其余包为 AGPL-3.0-only。
- `packages/items` 统一条目索引(知识地图数据层,见 `docs/adr/0003-item-index.md`)。
- `packages/storage` 唯一的数据库入口:SQLite 连接、迁移与备份、表定义与仓储(见 `docs/adr/0005-storage.md`)。其他包不得自己打开数据库。
- 设计记录放 `docs/adr/NNNN-标题.md`;模板文件放 `templates/`(不参与构建)。
- 包名统一 `@ai-personal/*`,ESM only(`"type": "module"`),相对导入写 `.js` 后缀。
- 代码风格:Prettier(4 空格缩进、120 列、单引号、LF);TS strict + `noUncheckedIndexedAccess`。

## 工作约定(计划第 13 节)

1. **小步提交**:每个功能点一个分支 / PR,使用 Conventional Commits(`feat(server): ...`);**提交说明、PR 标题与描述一律用英文**(面向外部)。PR 描述包含动机、改动、测试方式。分支命名 `feat/<topic>`、`fix/<topic>`、`docs/<topic>`。
2. **先契约后实现**:改动 `packages/shared` 的 schema / 事件协议前先写 ADR。
3. **测试先行**:新工具必须附带单测 + 至少一条评测用例;涉及审批 / 权限的改动必须有越权用例。
4. **不引入**:遥测 SDK、需要额外常驻服务的依赖、任何第三方 copyleft 依赖(GPL / LGPL / AGPL / SSPL 等:作者无权把别人的 copyleft 代码放进商业许可版,会破坏双许可)。只允许 MIT / BSD / ISC / Apache-2.0 / MPL-2.0(仅以未修改库形式使用)/ 0BSD / Unlicense 等宽松许可;`pnpm check:licenses` 在 CI 中强制。
5. **许可证头**:每个新建源文件开头写

   ```ts
   // SPDX-License-Identifier: AGPL-3.0-only
   // Copyright (C) 2026 尹绪柏 (Theodore Yin)
   ```

   `packages/plugin-sdk`、`packages/client`、`packages/shared` 用 `Apache-2.0`。YAML / Shell / Dockerfile 用 `#`,CSS 用 `/* */`,HTML 用 `<!-- -->`;年份为首次创建年份。JSON / Markdown 由 `REUSE.toml` 统一声明。各 `package.json` 写 `"license"` 与 `"author": "尹绪柏 (Theodore Yin) <x19169738916@163.com>"`。

6. **API 稳定性**:`/api/v1` 与 WebSocket 协议 v1 发布后只做向后兼容的增量修改;破坏性修改必须走 `/api/v2` 并写 ADR。Web UI 只能使用公开 API,禁止内部捷径。
7. **不确定时**:选择更简单、更安全(默认拒绝 / 默认需审批)的方案,并在 PR 中列出待业主决定的问题。**不要推翻第 16 节已定决策**:AGPL-3.0-only + 商业许可 + CLA;SDK 与 shared 为 Apache-2.0;1.0 只做企业微信 + 微信(QQ 以后);1.0 仅单用户(表结构预留 `ownerId`);不做付费代码签名;知识地图 1.0 为列表 / 树形浏览器,粒子球导航在 M10。
8. **文档同步**:用户可见的变化同步更新文档站与 CHANGELOG;中英文都要更新(英文可先由模型翻译,标注待校对)。
9. **署名**:提交说明和 PR 里不加 `Co-Authored-By` 之类的 AI 署名;提交作者一律为 `尹绪柏 (Theodore Yin) <x19169738916@163.com>`。
10. **仓库历史已重写(2026-11-10)**:开新会话前先同步到新的 `main`:先用 `git status` 确认工作区干净(有未提交的改动先保存或提交到自己的分支),再 `git switch main && git pull --ff-only`;快进失败说明是旧克隆,重新克隆即可,不要强推。不要从旧克隆推送 `main`、`docs/m3-wrapup`、`docs/memory-plan-tdam`。

## 净室实现(记忆模块等)

《记忆模块补充设计》借鉴了 GPL / AGPL 及许可证未核实的项目思想(见 `docs/adr/0007-memory-v2.md` 第 0 节)。实现时**只依据 `docs/plan/` 与 ADR 中我们自己写的规格**:不打开、不搜索、不复制这些项目的代码、SQL、提示词、测试数据、文案或配置,也不把它们加为依赖。

## 安全与隐私底线

- 默认只监听 `127.0.0.1`;对外部署必须经反向代理 + HTTPS。
- API Key 不入日志、不回显;日志只写本地,永不外传。
- 工具返回的外部内容(网页、邮件、文件)一律视为不可信;对外发送一律需审批。
- 日志为 JSON 行(`time` / `level` / `msg` + 字段,M1 起用 pino),只写本地。
- SQLite 连接打开后必须执行 `PRAGMA foreign_keys = ON`(SQLite 默认关闭外键约束,见 ADR 0003)。

## 语言

- 面向外部的内容(提交说明、PR、README、CONTRIBUTING、CLA 等)用英文;README 保留中英双版本。内部设计文档(ADR、计划)可用中文。
- 只沿用通用格式约定:LF 换行、4 空格缩进、120 列;不引入任何公司内部开发规范(分支模型、Java / MySQL / Redis 规则等)。

## 法律文件

`LICENSE`(AGPL-3.0 官方全文,**禁止修改**)、`NOTICE`、`COMMERCIAL.md`、`CLA.md`、`TRADEMARKS.md`、`SECURITY.md`。联系邮箱 x19169738916@163.com。

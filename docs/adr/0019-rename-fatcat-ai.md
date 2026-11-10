# ADR 0019 · 项目改名:AI-Personal → FatCat-AI

- 状态:提议(待业主审阅)
- 日期:2026-11-10
- 来源:业主 2026-11-10 要求;仓库已迁到 <https://github.com/CodingLossy/FatCat-AI>

## 背景

项目从 `CodingLossy/AI-Personal` 迁到新仓库 `CodingLossy/FatCat-AI`,名称统一改为 FatCat-AI。改名涉及包名、命令、数据目录和环境变量,已经在用的部署不能因此丢数据或突然读不到配置。

## 决定

1. **命名**
   - 显示名称 `FatCat-AI`;根包 `fatcat-ai`;workspace 包 `@fatcat-ai/*`;CLI 命令 `fatcat-ai`;Docker 镜像 `fatcat-ai`。
   - 客户端 SDK 的导出名随之改为 `FatCatClient`、`FatCatApiError`、`FatCatNetworkError`(包名本身已经变了,调用方无论如何都要改导入,所以不保留 `Aip*` 别名;SDK 尚未发布)。
   - 默认数据目录 `~/.fatcat-ai`(Windows 为 `%USERPROFILE%\.fatcat-ai`);Docker 仍是 `/data`。
   - 环境变量前缀 `AIP_` → `FATCAT_AI_`。
2. **旧环境变量**:server 与 CLI 启动时,对自己读取的每个变量,若设置了旧名 `AIP_<NAME>`,在新名 `FATCAT_AI_<NAME>` 未设置时用旧名的值(新名优先),并打印一次弃用警告(server 写日志,CLI 写 stderr),列出旧名与新名。实现为 `packages/shared` 的 `applyLegacyEnv`。只兼容运行时变量;开发 / 评测 / 性能脚本的变量(`FATCAT_AI_DEV_SERVER`、`FATCAT_AI_EVAL_*`、`FATCAT_AI_PERF_*`)直接改名。兼容计划在 1.0 发布前移除。
3. **MCP 环境变量**:`FATCAT_AI_*` 与旧名 `AIP_*` 都属于本服务自己的配置,永远不传给 MCP 子进程(ADR 0013 第 4 节)。
4. **数据目录迁移**:只在使用默认数据目录(未设置 `FATCAT_AI_DATA_DIR` / `AIP_DATA_DIR`)时,server 启动、打开数据库之前执行:
   - 旧目录 `~/.ai-personal` 不存在 → 什么都不做。
   - 新目录 `~/.fatcat-ai` 已存在 → **不覆盖**,用新目录,旧目录原样保留,每次启动写一条警告。
   - 否则先原子重命名;跨盘(`EXDEV`)时复制到新目录旁的临时目录,逐文件比对大小与 SHA-256 一致后改名为新目录,再删除旧目录;校验失败则删除临时目录并拒绝启动,旧目录不动。
   - 迁移后旧目录不再存在,所以只会做一次;每次迁移写一条 info 日志。
   - CLI 不迁移:新目录不存在而旧目录存在时继续读写旧目录里的 `cli.json`,等 server 迁移。这样 CLI 不会先建出新目录而让 server 跳过迁移。
5. **有意保留的旧标识**(属于 `/api/v1` 线上协议或已发出的凭据,改名会让现有令牌失效或破坏 v1 兼容):
   - 个人访问令牌前缀 `aip_pat_`(以及密钥扫描、日志脱敏中的同名规则);
   - Cookie `aip_session`、`aip_csrf`;
   - 响应头 `X-AIP-Server-Version`。
     是否在 `/api/v2` 或 1.0 前改名,由业主决定。
6. **历史文档**:`docs/milestones/` 下的自检与里程碑方案是过去的记录,保留旧名,文件开头加一句改名说明;ADR 与 `docs/plan/` 按新名更新。指向旧仓库 PR 的链接(CHANGELOG 等)保留,因为新仓库的 PR 编号不同。

## 后果

- `/api/v1/meta` 的 `name` 由 `AI-Personal` 改为 `FatCat-AI`,oasdiff 判为 v1 破坏性变更(`response-property-enum-value-added`)。v1 尚未发布,业主 2026-11-10 批准以一次性例外处理:`.github/oasdiff-err-ignore.txt` 只列这一条,合并后应清空。

- 已有部署升级后自动迁到新目录,旧环境变量继续生效但有警告。
- Docker 卷名 `ai-personal-data` 不改:改名会让 `docker compose` 新建一个空卷,看起来像数据丢失。
- 降级到改名前的版本时,旧版本会在 `~/.ai-personal` 新建空目录;需要手动把目录改回旧名。

# M0 自检报告

> 注:项目已于 2026-11-10 由 AI-Personal 改名为 FatCat-AI(ADR 0019)。本文是当时的记录,文中的包名 `@ai-personal/*`、命令 `ai-personal`、目录 `~/.ai-personal` 与 `AIP_*` 环境变量现在分别是 `@fatcat-ai/*`、`fatcat-ai`、`~/.fatcat-ai` 与 `FATCAT_AI_*`。

- 日期:2026-11-03(第二版:已按业主答复修订)
- 分支:`main`(本地仓库,尚未推送;共 18 个提交,提交说明均为英文)
- 环境:Windows 11,Node 24.15.0,pnpm 10.11.1;**本机未安装 Docker**

## 一、M0 验收标准(计划第 8 节)

| #   | 验收项                                     | 结果                        | 依据                                                                                                                                                                               |
| --- | ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm i && pnpm dev` 同时起 server 和 web  | ✅ 通过                     | 本地实测:`/healthz` 200,`:5173` 200,经 Vite 代理访问 `/api/v1/meta` 正常                                                                                                           |
| 2   | `docker compose up` 后 `/healthz` 返回 200 | ⚠️ 未在本机验证             | 本机无 Docker。已在本地模拟镜像的 deploy 阶段(`pnpm deploy --prod --legacy`),产物 11MB,能启动并托管 Web UI;CI 的 `docker` 任务会构建镜像并检查 `/healthz`                          |
| 3   | CI 全绿                                    | ⚠️ 本地全绿,GitHub 上未运行 | 仓库尚未推送。本地已逐项跑通:format:check、lint、typecheck、test(12 个用例)、build、check:spdx、check:placeholders、check:licenses、`reuse lint`、`pnpm install --frozen-lockfile` |
| 4   | 镜像空闲 RSS < 120MB                       | ⚠️ 未在本机验证             | 本地以生产方式运行 deploy 产物,Windows 工作集约 67MB(仅供参考);CI 的 `docker` 任务读取容器内 `VmRSS` 并断言 < 120MB                                                                |

M0 范围内的其他内容:

| 项目                                                                                                                                        | 结果                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pnpm + Turborepo 单仓;TS strict、ESLint flat、Prettier、Vitest                                                                              | ✅ TS 6.0.3、ESLint 10、Prettier 3.9、Vitest 5.1                                    |
| 第 5 节目录:apps/{server,web,cli,docs,desktop},packages/{shared,agent,providers,tools,memory,items,channels,plugin-sdk,client,ui,i18n,eval} | ✅ cli / docs / desktop 只放了说明文件;其余包为可构建的空包                         |
| `apps/server`(Hono,`/healthz`)                                                                                                              | ✅ 另加了 `/api/v1/meta`(含 `license`、`sourceUrl`)和 `X-AIP-Server-Version` 响应头 |
| `apps/web`(Vite + React 空壳)                                                                                                               | ✅ 页脚显示许可证与源码链接                                                         |
| `packages/shared`                                                                                                                           | ✅ Apache-2.0,含 meta / health 的 zod schema                                        |
| CLAUDE.md / AGENTS.md                                                                                                                       | ✅ 内容在 AGENTS.md,CLAUDE.md 通过 `@AGENTS.md` 导入                                |
| Issue / PR 模板                                                                                                                             | ✅                                                                                  |
| Dockerfile(多阶段、node slim、非 root)与 docker-compose                                                                                     | ✅(待 CI 验证)                                                                      |
| ADR 0001 / 0002 / 0003                                                                                                                      | ✅                                                                                  |
| Changesets 或 release-please                                                                                                                | ❌ 未做,见第三节                                                                    |

## 二、许可证落地清单(计划 15.9)

| 清单项                                                                        | 结果        | 说明                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE` 为 AGPL-3.0 官方全文,原样未改                                       | ✅          | 与 templates/LICENSE 逐字节一致,SHA-256 `0d96a4ff…abcb0` 与 gnu.org 官方文本相同                                                  |
| `NOTICE`                                                                      | ✅          | 取自模板                                                                                                                          |
| `COMMERCIAL.md`,无占位符                                                      | ✅          | 取自模板                                                                                                                          |
| `SECURITY.md`                                                                 | ✅          | 取自模板                                                                                                                          |
| `CLA.md`(+ 企业 CCLA),CLA Assistant 已启用并设为必过                          | ⚠️ 部分完成 | CLA.md(ICLA + CCLA,中英文)和 `.github/workflows/cla.yml` 已完成;**设为必过检查需要在 GitHub 分支保护中手动开启**,仓库建好后才能做 |
| `CONTRIBUTING.md`                                                             | ✅          | 包含 CLA、提交规范、依赖白名单                                                                                                    |
| `TRADEMARKS.md`                                                               | ✅          |                                                                                                                                   |
| 所有源文件 SPDX 头;SDK 包 Apache-2.0;`reuse lint` 通过                        | ✅          | `check-spdx` 检查 116 个文件,`reuse lint` 符合 REUSE 3.3                                                                          |
| `package.json` 的 `license` / `author` 正确;SDK 包有 Apache-2.0 LICENSE       | ✅          | 由 `check-spdx` 检查;3 个 SDK 包的 LICENSE 与 apache.org 官方文本 SHA-256 一致。目前还没有 Cargo.toml(M10 才有)                   |
| CI 检查无占位符残留                                                           | ✅          | `check-placeholders`(templates/ 与 docs/plan/ 是模板来源,不检查)                                                                  |
| license-checker 白名单在 CI 中强制                                            | ✅          | 自写脚本基于 `pnpm licenses list`,没有引入额外依赖;共 179 个包,唯一的 MPL-2.0 是 Vite 的 lightningcss(开发依赖、未修改),输出警告  |
| Web UI 源码链接、`/api/v1/meta` 的 `license` / `sourceUrl`、IM `/source` 指令 | ⚠️ 部分完成 | 前两项已完成,`sourceUrl` 默认 <https://github.com/CodingLossy/AI-Personal>,可用 `AIP_SOURCE_URL` 覆盖;IM `/source` 要等 M5 渠道   |
| Docker 镜像 OCI 许可证与源码标签;发布产物附 SBOM                              | ⚠️ 部分完成 | OCI 标签已加(source 由构建参数传入);SBOM 等发布流程(M5)再做                                                                       |
| README 中英文许可证段落(15.6)                                                 | ✅          | 原文照用                                                                                                                          |
| 第一个外部 PR 合并前确认 CLA 流程跑通                                         | ⏳ 未到时间 |                                                                                                                                   |
| 签第一份商业合同前请律师审阅                                                  | ⏳ 未到时间 | CLA.md 顶部已注明                                                                                                                 |

## 三、未完成项及原因

1. **Docker 构建、compose 启动、镜像 RSS 未在本机验证**:本机没有 Docker。CI 已包含对应任务,推送后可以验证。
2. **CI 未在 GitHub 上运行、CLA Assistant 未设为必过**:等业主确认后推送,见第五节。
3. **Changesets / release-please 未接入**:release-please 依赖 GitHub 仓库与发布流程,打算在第一次发布(M5)前和 GHCR 镜像发布一起接入,M0 先不引入额外依赖。
4. **IM `/source` 指令、SBOM**:分别属于 M5 渠道与发布流程。

## 四、业主答复与处理结果

| #   | 业主答复                                                                 | 处理                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | owner 为 CodingLossy,源码地址 https://github.com/CodingLossy/AI-Personal | `shared` 新增 `OFFICIAL_SOURCE_URL`,server 未设置 `AIP_SOURCE_URL` 时默认用它,`/api/v1/meta` 与页脚显示该链接;15 个 package.json 补上 `repository` / `bugs` / `homepage`;README、COMMERCIAL、CLA、SECURITY、TRADEMARKS、文件头模板更新链接                                                                                                                                                                                         |
| 2   | rule.json 只保留通用格式规则;对外内容用英文;允许外键                     | 保留 LF、4 空格、120 列;日志从公司格式改为 JSON 行(pino 风格);分支改名为 `main`,约定改为 `feat/<topic>`;CONTRIBUTING 改为英文,COMMERCIAL 增加英文正文,package.json 描述改为英文;之前 12 条中文提交说明改写为英文(内容不变,留有备份 tag `backup/pre-english-messages`);ADR 0003 恢复 `REFERENCES items(id) ON DELETE CASCADE`,ADR 0001 / AGENTS.md 规定每个 SQLite 连接执行 `PRAGMA foreign_keys = ON`(M1 实现存储层时落地并加测试) |
| 3   | 提交身份保持个人邮箱                                                     | 全部 18 个提交作者均为 `尹绪柏 (Theodore Yin) <x19169738916@163.com>`                                                                                                                                                                                                                                                                                                                                                              |
| 4   | TS 保持 6.0.3                                                            | 不变                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | CLA 以英文版为准                                                         | 英文正文移到前面并标为 governing,中文改为「仅供参考」的译本,版本号升为 1.1                                                                                                                                                                                                                                                                                                                                                         |
| 6   | 原始计划文件保持 gitignore                                               | 不变                                                                                                                                                                                                                                                                                                                                                                                                                               |

计划原文(`docs/plan/`)的 6.2 节从未改动,外键定义本来就在。

## 五、推送到 GitHub 的步骤(等业主确认后执行)

1. 在 GitHub 上以 CodingLossy 创建空仓库 `AI-Personal`(Public,**不要**勾选初始化 README / LICENSE / .gitignore)。
2. 添加远端并推送 `main`(备份 tag 不会被推送,`git push` 默认不推 tag):
   ```bash
   git remote add origin https://github.com/CodingLossy/AI-Personal.git
   git push -u origin main
   ```
3. 为 CLA Assistant 创建存放签名的空分支:
   ```bash
   git switch --orphan cla-signatures
   git commit --allow-empty -m "chore: initialize CLA signatures branch"
   git push -u origin cla-signatures
   git switch main
   ```
4. 在 Actions 页确认 CI 的 `check`、`compliance`、`docker` 三个任务全绿(docker 任务会验证镜像构建、`/healthz`、非 root、空闲 RSS < 120MB)。如有失败我来修。
5. Settings → Branches:为 `main` 添加保护规则——要求 PR、要求状态检查通过(`lint / typecheck / test / build`、`license compliance`、`docker image`、`cla`),`cla-signatures` 分支不要加保护。
6. Settings → Code security:开启 Private vulnerability reporting(SECURITY.md 已链接)。
7. 可选:在 Settings → General 中填写 About(描述、主页)与 Topics。
8. 确认无误后删除本地备份 tag:`git tag -d backup/pre-english-messages`。

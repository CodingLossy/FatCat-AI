# M5c 自检报告(发布收尾)

- 日期:2026-11-16
- 基线:`main` @ `e921c63`(#41 合并后),本 PR(`release/v1.0-prep`)叠在 #42 → #43 → #44 → #46 之上。
- 对照依据:`docs/milestones/M5c-plan.md` 第 2–4 节、ADR 0018、0030、0031、0032。
- 方式:C 读取各 PR 描述里的测试记录;本 PR 的改动与内存测量在云容器(Linux,4 核 / 16 GiB,Node 24.22,Docker 29.9)上实际跑过。**没有在真机、真实域名、真实邮箱或真实微信上测,没有向 GHCR 推送任何东西。**

**结论**:M5c 方案的 5 个 PR 都已有实现(#42、#43、#44、#46 待合并,本 PR 为第 5 个)。自动化可验证的验收项有对应;**内存数字在云容器上达标,但有一条需要业主和 X 判断(第二节:渠道规则 4)**;2C2G 实机、真实域名、手机真机、真实验证器与微信账号、Windows 全部未验证(第四节)。**没有 tag、没有 Release、GHCR 上没有新镜像。模型组合留空,等业主确认。**

## 一、逐 PR 对照

| PR  | 分支 / 编号                | 验收项(方案第 2 节)                                   | 结果                          | 依据                                                                                 |
| --- | -------------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `docs/m5c-plan`,#42        | 方案、渠道范围订正为「1.0 只含微信」                  | ✅ 待合并                     | PR 描述;`docs/plan` 第 16 节第 3 条                                                  |
| 2   | `ci/openapi-and-scan`,#43  | 路由与 OpenAPI 覆盖测试、oasdiff 自测、CodeQL、ADR 30 | ✅ 待合并;CodeQL 首次运行通过 | `apps/server/src/openapi-coverage.test.ts`;`scripts/check-openapi-breaking.test.mjs` |
| 3   | `feat/web-mobile`,#44      | 手机宽度可用,各宽度无横向滚动                         | ✅ 待合并;❌ 真机未验证       | `apps/web/e2e/mobile.e2e.ts`                                                         |
| 4   | `docs/deploy-docker`,#46   | 2 GB 部署文档、Caddy、DNSPod 示例、部署冒烟           | ✅ 待合并;❌ 真实域名未验证   | `scripts/deploy-smoke.mjs` 12/12;CI `deploy smoke`                                   |
| 5   | `release/v1.0-prep`(本 PR) | 见下                                                  | 见下                          | 见下                                                                                 |

### 本 PR 的验收项(方案 PR 5)

| 验收项                                              | 结果                                        | 依据                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 发布工作流在「不推送」模式下 amd64 与 arm64 都跑通  | ❌ 本地只构建了 amd64;arm64 待本 PR 的 CI   | `.github/workflows/release.yml` 的 `image` 任务在 PR 上各用原生 runner 构建并健康检查;本地 `docker build` 通过(amd64)                            |
| 默认不推送;推送只有 `v*` tag 或手动 `push=true`     | ✅ 工作流静态检查                           | `publish` 任务的 `if`;ADR 0032;**从未实际推送过,`publish` 任务没有运行过**                                                                       |
| 仓库没有 `v1.0*` tag、没有 Release、GHCR 没有新镜像 | ✅                                          | 见下方「核对命令与结果」                                                                                                                         |
| v1.0 Release Notes 草稿(中英)                       | ✅ 草稿;模型组合留空                        | `docs/release/v1.0-notes.md`、`v1.0-notes.en.md`                                                                                                 |
| README 快速开始以 Docker 为主                       | ✅;❌ 业主按文档走一遍未做                  | `README.md`、`README.en.md`;下面的命令 `docker compose -f docker/docker-compose.yml up -d --build` 与日志取设置码在本地跑过(构建与启动,见第三节) |
| 基线按 ADR 0018 更新为实测值                        | ✅ 基线保持 111(实测 111.3 / 110.7 / 111.3) | `.github/memory-baseline.json`、ADR 0018 第 3 节                                                                                                 |
| 版本号不改、`CHANGELOG` 保持 Unreleased             | ✅                                          | 各 `package.json` 仍为 `0.0.0`                                                                                                                   |

**核对命令与结果**(2026-11-16,本 PR 分支上):

```text
$ node scripts/check-no-release.mjs
ok   no v* tags on origin
??   could not list releases: HTTP 403        # 云容器的代理不允许直连 api.github.com;Release 用 GitHub 连接器核对,见下
ok   GHCR codinglossy/fatcat-ai: no public package (anonymous token denied: package missing or private)
```

GitHub 连接器 `list_releases`(仓库 `CodingLossy/FatCat-AI`)返回空列表;`git ls-remote --tags origin` 无输出。GHCR 的匿名核对只能说明「没有公开包」,私有包是否存在要业主在 GitHub 的 Packages 页确认。

## 二、开发计划 M5c 验收项(方案第 4 节)

| 验收项                                           | 结果                                                           | 依据                                                            |
| ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| 冻结前复核 oasdiff 覆盖 `/api/v1` 全部路径       | ✅(#43)                                                        | `openapi-coverage.test.ts`                                      |
| CI 补上 CodeQL                                   | ✅(#43)                                                        | `.github/workflows/codeql.yml`                                  |
| Web UI 响应式适配手机                            | ✅ 视口冒烟;❌ 真机(#44);本 PR 补了抽屉焦点管理(e2e 覆盖)      | `apps/web/e2e/mobile.e2e.ts`                                    |
| Docker 一键部署文档                              | ✅ 冒烟;❌ 真实域名与 DNSPod(#46)                              | `docs/deploy/docker.md`                                         |
| Docker 镜像到 GHCR                               | ✅ 构建工作流;**未推送,等业主确认**                            | `release.yml`、ADR 0032                                         |
| v1.0 Release Notes                               | ✅ 草稿;**未发布**                                             | `docs/release/`                                                 |
| README 快速开始                                  | ✅ 已改;业主未走过                                             | `README.md`                                                     |
| 内存基线更新为实测值                             | ✅                                                             | ADR 0018 第 3 节                                                |
| 空闲 ≤ 250 MiB                                   | ✅ 111.3 MiB                                                   | `idle-budget.mjs` 三次,镜像内 VmRSS 中位数                      |
| 同步后回落 / 不持续上涨(规则 3、4,邮件)          | ✅ 1 万封 × 3 次:110.9 → 145.8 / 148.5 / 148.8 MiB(+37.9,+0.3) | `CHECK=1 pnpm perf:mail-sync`:`ADR 0018 rules 3 and 4: passed`  |
| 渠道增量不超上限                                 | ✅ +12.5 MiB(上限 25)                                          | `pnpm perf:channel`                                             |
| 渠道 4 × 100 条对话后回落(规则 4,渠道)           | ⚠️ 第 1 次本地运行规则 4 的累计检查失败,第 2 次通过(见下)      | `RUNS=4 CHECK=1 pnpm perf:channel`                              |
| 涨幅 ≤ 20%                                       | ✅ 相对基线 111:+0.3% / -0.3% / +0.3%                          | 同上                                                            |
| 对话峰值 < 400 MiB                               | ✅ 145.8 MiB(30 轮,每轮工具调用 + 约 40 KiB 流式回复)          | `node scripts/perf/chat-peak.mjs`(镜像内);60 秒后回到 118.7 MiB |
| 2C2G 机器经 HTTPS 域名登录使用;2C2G 上的内存读数 | ❌ 未验证                                                      | 业主                                                            |

测量命令(都在云容器上,镜像用 `docker build -f docker/Dockerfile` 构建;容器里只有 CA 证书是临时注入的,仓库里的 Dockerfile 没改):

```bash
# 空闲:三个新容器,启动后 10 秒起每 5 秒采样 3 次
docker run -d --name fcN -p 127.0.0.1:878N:8787 fatcat-ai:prep; sleep 10
docker exec fcN sh -c 'grep VmRSS /proc/1/status'    # x3
node scripts/perf/idle-budget.mjs <三个采样>
# 对话峰值
docker run -d --name fcp -p 127.0.0.1:8790:8787 -e PEAK_KEY=x --add-host host.docker.internal:host-gateway fatcat-ai:prep
node scripts/perf/chat-peak.mjs http://127.0.0.1:8790 <设置码> fcp
# 邮件与渠道(runner 上直接跑构建好的服务器)
CHECK=1 pnpm perf:mail-sync
RUNS=4 CHECK=1 pnpm perf:channel
```

## 三、本 PR 自测

见 PR 描述的命令与结果表。本地验证过:镜像构建(amd64)、三次空闲读数、对话峰值、邮件 3 次同步、渠道 4 次、`pnpm format:check` / `lint` / `typecheck` / `check:spdx` / `check:placeholders` / `check:egress` / `check:licenses`、手机 e2e。

## 四、真机与人工项(业主侧,C 没有测)

| 项                                                                                                       | 需要               | 状态         |
| -------------------------------------------------------------------------------------------------------- | ------------------ | ------------ |
| 2C2G Linux + 真实域名:按部署文档 `docker compose up -d`,经 HTTPS 登录,证书签发与续期                     | 真实机器与域名     | 未验证       |
| DNSPod 子账号权限与 DNS-01 真实签发                                                                      | DNSPod 账号        | 未验证       |
| 2C2G 实机内存读数:空闲、万封同步后、对话峰值(本 PR 的数字来自云容器)                                     | 真实机器           | 未验证       |
| 在 GHCR 上首次真实推送:`publish` 任务的 QEMU 构建耗时、包设为 Public、provenance 附加                    | 业主确认后手动触发 | 未验证       |
| `release.yml` 在 PR 上的 arm64 构建(CI 首次运行)                                                         | CI                 | 待 CI        |
| iOS Safari / Android Chrome:登录、聊天、软键盘、审批卡片、知识地图、TOTP 输入;抽屉焦点与「返回列表」焦点 | 真实手机           | 未验证       |
| 邮件 list → message 的「返回列表」焦点(e2e 没有邮件账号,只有代码与类型检查)                              | 真实邮箱           | 未验证       |
| 真实验证器 App 的 TOTP 开启与登录;真实微信的收发与审批                                                   | 手机、微信账号     | 未验证       |
| Windows 真机:`pnpm dev` 与数据目录                                                                       | Windows            | 未验证       |
| README 快速开始:业主按文档完整走一遍                                                                     | 业主               | 未验证       |
| 英文文档(部署指南、发布说明)校对                                                                         | 业主               | 未验证       |
| **最终模型组合**                                                                                         | 业主               | **等待用户** |
| **发布决定:版本号改 1.0.0、ADR 0030 填冻结日期与哈希、打 tag、创建 Release、向 GHCR 推正式标签**         | 业主               | **等待用户** |

## 五、遗留与去向

- **渠道规则 4 的结果不稳定**:`RUNS=4 CHECK=1 pnpm perf:channel` 本地跑了两次。第 1 次每次对话后 60 秒的读数是 126.2 / 119.8 / 128.7 / 130.8 MiB,第 2 轮的 119.8 是一次偏低的回落,导致「从第 2 次起每次都涨 ≥ 2 MiB 且最后一次比第 2 次高出 > 6 MiB」(+11)而失败;第 2 次是 126.3 / 131.0 / 132.5 / 133.0 MiB,通过(增量 +12.5 MiB,两次相同)。两次的最后一次读数相差 2.2 MiB,逐次上涨的幅度在变小,看起来是台阶后趋平而不是线性泄漏,但 4 次样本不能排除。没有改动任何阈值或脚本。推荐:发布前在 main 上用 `memory-load.yml` 跑几次看 CI 的结果;若 CI 也出现偶发失败,另开一个 PR 把规则 4 的累计检查改为比较最后一次与前几次的中位数。
- ADR 0031 第 3 节的已知限制(代理后登录限速是共享计数器):推荐 1.0 保持,1.0.x 另开 PR 加 `FATCAT_AI_TRUSTED_PROXY`。
- cosign 签名、PWA、企业微信:1.0 之后(企业微信排期另定)。
- M5b 自检中仍未验证的真机项继续有效。

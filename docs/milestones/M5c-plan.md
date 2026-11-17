# M5c 实施方案:安全扫描与 API 冻结复核、手机响应式、Docker 部署文档、发布收尾

- 状态:草案,待业主确认第 5 节的问题
- 日期:2026-11-16(America/Los_Angeles,业主所在时区)
- 基线:`feat/channel-map`(M5b PR 9,#41,未合并)。本分支基于它;#39 已合并,#40、#41 合并后本 PR 只剩自己的差异
- 依据:开发计划 M5c 一节(第 8 节)、第 11 节(安全与性能)、第 12 节(资源预算)、第 16 节;ADR 0010 第 10 节(oasdiff)、ADR 0018(内存预算);`docs/milestones/M5b-plan.md` 第 6 节(推迟项)
- 范围控制:本 PR 只改文档,不改 `packages/`、`apps/`、`docker/`、`.github/` 下任何文件,不加迁移。除第 3 节的 1.0 渠道范围订正外,不动第 16 节已定决策。

## 0. 范围

业主 2026-11-16 同意把 M5 剩下的做完,直到 v1.0 发布前为止。**企业微信继续推迟,不在 M5c,也不在 1.0**(第 16 节第 3 条同步改为「1.0 只含微信,企业微信推迟、排期另定」)。

在 M5c:

1. 冻结 `/api/v1` 前复核 oasdiff 覆盖全部路径;CI 补上 CodeQL 或 Semgrep。
2. Web UI 适配手机尺寸。
3. Docker 一键部署文档:2 GB 机器配置、Caddy 自动 HTTPS、DNSPod DNS 验证示例。
4. 发布收尾:GHCR 镜像(amd64 / arm64)的构建流程、v1.0 Release Notes 草稿、README 快速开始、内存基线更新为实测值、M5c 自检报告。

**不做(需要业主确认后才能做)**:不打 `v1.0` tag,不创建 GitHub Release,不向 GHCR 的正式标签(`1.0.0`、`1`、`latest`)推送镜像,不确定最终模型组合(第 5 节问题 3)。

不在 M5c:企业微信(第 16 节第 3 条);粒子球导航(M10);定时推送到渠道(M6);多用户(2.0);桌面与手机客户端(M10、M11)。

### 当前代码状态(决定了从哪里起步)

- **oasdiff**:`.github/workflows/ci.yml` 的 `openapi-compat` 任务只在 PR 上比较基线分支与本分支的 `apps/server/openapi/v1.json`,用 `tufin/oasdiff:v1.35.0` 的 `breaking --fail-on ERR`,严重度表在 `.github/oasdiff-severity.txt`,一次性例外在 `.github/oasdiff-err-ignore.txt`(目前为空)。同一个 CI 的 `check` 任务重新导出文档并要求与仓库中的文件一致。文档现有 89 个路径、115 个操作。
- **路径覆盖**:`apps/server/src/app.ts` 里 `/api/v1` 下的路由都挂在 `OpenAPIHono` 上(`app.ts:220` 的 `/healthz` 不在 `/api/v1` 下,`app.ts:337` 的 `/api/*` 兜底返回 404)。但没有测试保证「以后新增的路由一定进文档」,也没有检查哪些路径被有意排除。这是第 2 节 PR 2 要补的。
- **代码扫描**:CI 没有 CodeQL、Semgrep 或同类工具(只有 `check:secrets`、`check:licenses`、`check:egress`)。
- **Web 响应式**:`apps/web/src/styles.css` 只有 3 处 `@media (max-width: 720px)`(约在 645、692、837 行)和 1 处深色模式;没有 viewport 之外的手机验证,没有手机尺寸的 Playwright 用例。
- **Docker**:`docker/Dockerfile`(多阶段,非 root 用户,`NODE_OPTIONS` 含 `--max-old-space-size=384 --max-semi-space-size=8`)、`docker/docker-compose.yml`(绑定 `127.0.0.1`,`mem_limit: 512m`,卷 `ai-personal-data`)。没有 Caddy、没有反向代理配置、没有部署文档;compose 里的卷名还是旧名 `ai-personal-data`(改名会让已有部署看不到数据,见第 5 节问题 6)。
- **发布**:没有发布工作流,没有 GHCR 推送;所有包版本为 `0.0.0`;`CHANGELOG.md` 只有 `[Unreleased]`,没有已发布版本。
- **内存**:`.github/memory-baseline.json`:空闲基线 111 MiB(2026-11-10 测得,commit `1f57f1e`),微信增量上限 25 MiB;`memory-load.yml` 在 main 上跑万封同步与渠道增量(ADR 0018)。M4、M5a、M5b 之后的实测值还没有写回基线。

## 1. PR 顺序

共 5 个 PR(含本 PR),符合业主估计。每个 PR 推送后,下一个分支基于它的分支开出;依赖写在各 PR 的描述里。

| #   | 分支                  | 范围(摘要)                                                                                     | 风险                     | 依赖              |
| --- | --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ | ----------------- |
| 1   | `docs/m5c-plan`       | 本方案;开发计划第 16 节第 3 条与其他文档里「1.0 做企业微信」的说法订正                         | 低                       | #41(及其依赖 #40) |
| 2   | `ci/openapi-and-scan` | oasdiff 覆盖复核(路由与文档一致性测试)、代码扫描(CodeQL 或 Semgrep)、冻结 `/api/v1` 的检查清单 | 中(CI 身份检查与权限)    | 1                 |
| 3   | `feat/web-mobile`     | Web UI 手机响应式、手机尺寸 Playwright 冒烟、截图                                              | 低(界面)                 | 2                 |
| 4   | `docs/deploy-docker`  | Docker 一键部署文档(中英)、生产用 compose 与 Caddy 配置、DNSPod 示例                           | 中(对外暴露、密钥)       | 3                 |
| 5   | `release/v1.0-prep`   | GHCR 构建流程(不推正式标签)、Release Notes 草稿、README 快速开始、内存基线实测、M5c 自检报告   | **高(发布、镜像、基线)** | 4                 |

顺序理由:

- PR 2 先做,因为「冻结 `/api/v1`」是发布的前提;之后如果还要改接口,必须在 PR 2 的检查之下做。PR 3 只用现有接口,不应动 OpenAPI;万一需要加接口,只能是向后兼容的增量,并过 PR 2 的检查。
- PR 4 在 PR 3 之后,是因为部署文档里要放手机访问的截图与「手机登录」的步骤。
- PR 5 最后:基线、镜像、Release Notes 和自检都依赖前面的内容已定。
- 任何一个 PR 都不阻塞业主的真机清单(第 4 节)。

## 2. 各 PR 的范围与验收

每个 PR 都要在描述里写:改了什么、怎么测的(命令和结果)、还没验证的部分、需要业主决定的问题(先写推荐)。涉及密钥、发布或 CI 权限的 PR 在描述最上面加粗标出。每个 PR 都跑 `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm check:egress`、`pnpm check:spdx`、`pnpm check:placeholders`、`pnpm check:licenses` 与 `node scripts/check-commit-identity.mjs`。

### PR 1 · `docs/m5c-plan`(本 PR)

- 目标文件:新增 `docs/milestones/M5c-plan.md`;修改开发计划(第 2 节渠道表、架构图、M5 标题与 M5a 标题、M5a 验收、第 13 节第 7 条、风险表、第 16 节第 3 条及其摘要)、`README.md`、`README.en.md`、`AGENTS.md` 里的「1.0 做企业微信」说法。
- 不改:`CHANGELOG.md`(里面没有这样的说法)、ADR 0018 / 0022 / 0028(它们写的已经是「企业微信推迟」)、M5a / M5b 方案与自检(同上)、开发计划第 3 节「小团队(2.0)在企业微信里共享助手」(这是 2.0 的场景,不是 1.0 范围)。
- 注意:`CLAUDE.md` 的「自动流程」里「当前是 M5b」之类的阶段说法由 M5b PR #37 的收尾项更新,不在本 PR。
- ADR:不需要。迁移:无。风险:低(纯文档)。
- 验收:`pnpm format:check`、`pnpm check:placeholders`、`node scripts/check-commit-identity.mjs` 通过;`grep` 全仓库(排除 `node_modules`、`dist`)里不再有「1.0 做企业微信」的说法;CI 全绿。

### PR 2 · `ci/openapi-and-scan`

- **oasdiff 覆盖复核**(开发计划 M5c 第一条,「冻结前复核它覆盖 `/api/v1` 的全部路径」):
  - 新增服务端测试(`apps/server/src/openapi-coverage.test.ts`):启动 `createApp`,取 Hono 的路由表,断言 `/api/v1` 下每个「方法 + 路径」都在 `buildOpenApiDocument()` 的输出里,反过来文档里每个操作都有对应的路由;显式排除的路径(`/api/v1/openapi.json` 自身、`/api/*` 兜底)写在测试里的一个白名单,并附原因。以后新增路由忘了进文档,测试直接失败。
  - 检查 `openapi-compat` 任务对 PR 的覆盖:现在只在 `pull_request` 上跑;对 main 的 push 不跑,所以直接推 main(受保护,正常不会发生)或第一个 PR 没有基线时会跳过。补一条:基线不存在时只在 PR 描述里说明,不静默通过(现有脚本在基线没有文档时直接 `exit 0`,这一条要核实它只会在引入文档的那一个 PR 里出现)。
  - 核对严重度表 `.github/oasdiff-severity.txt` 里放宽的三项(事件联合类型新增变体、响应 enum 值新增)与 ADR 0004「客户端忽略未知事件类型」一致;写进冻结清单。
  - 加一个 oasdiff 的「注入破坏性变更」自测:CI 里临时改一份文档(删一个必填响应字段)确认 `breaking` 会失败。做成脚本测试而不是长期保留的 CI 步骤,避免拖慢 CI。
- **代码扫描**:见第 5 节问题 1。推荐 CodeQL(GitHub 官方工作流 `github/codeql-action`,语言 `javascript-typescript`,在 push 到 main、PR、每周定时跑)。如果仓库是私有且没有 Code Security,CodeQL 的结果上传会失败;此时改为 Semgrep 的开源规则集以容器运行(与 oasdiff 一样不是项目依赖,不进 `package.json`),结果只在 CI 日志与 SARIF 工件里看。两者都需要:
  - 工作流权限最小化(`security-events: write` 只给扫描任务);
  - 动作固定到提交 SHA 或明确的主版本,并过 `check:licenses`(它们是 CI 工具,不是项目依赖);
  - 首次扫描的告警逐条分类:真问题当场修(列在 PR 里),误报用规则内的忽略并写原因,不整类关闭;
  - 与「不引入遥测」一致:这些工具只在 CI 里跑,产品不包含它们。
- **冻结清单**:新增 `docs/adr/0030-api-v1-freeze.md`(只在冻结前写一次):冻结日期、冻结范围(`apps/server/openapi/v1.json` 的哈希或版本)、冻结后允许的变更(向后兼容的增量)、`oasdiff-err-ignore.txt` 必须为空、WebSocket 协议 v1 的冻结范围与对应的契约测试在哪里。
- 迁移:无。风险:中(改 CI 与权限)。**需要业主决定的 CI 权限变更在描述最上面标出。**
- 验收:覆盖测试通过且故意漏登记一个路由时失败(在描述里贴本地演示);扫描工作流在 PR 上跑通并给出结果;冻结 ADR 写明冻结范围;CI 全绿。

### PR 3 · `feat/web-mobile`

- 目标:`apps/web` 在手机尺寸(常见宽度 360、390、430 px,以及横屏)可用:导航(顶栏 + 抽屉或底部标签,按现有 `Shell.tsx` 的结构选更小的改动)、聊天(输入框随软键盘、审批卡片不溢出、工具卡可折叠)、设置页(各分区单列、表格改卡片或横向滚动)、记忆页、邮件页、知识地图(`CategoryBrowser` 的树与详情在手机上是「列表 → 详情」两屏)、登录与 TOTP 页(验证码输入用 `inputmode="numeric"`、`autocomplete="one-time-code"`)。
- 做法:沿用现有 `styles.css` 的断点写法,先盘点现有 3 处 `@media` 与哪些页面在 360 px 下横向溢出,再逐页修;触控目标至少 44 px;不引入 CSS 框架或新依赖;`viewport` 元标签与 `theme-color` 检查;不改任何 API。
- 测试:Playwright 增加手机视口项目(`devices['Pixel 7']` 或 390 × 844),冒烟用例覆盖「登录 → 发一条消息 → 打开设置 → 打开知识地图并下钻」且断言页面没有横向滚动(`scrollWidth <= clientWidth`);Vitest 只为有逻辑的组件(例如导航开合状态)写单测。
- 截图:每个改动的页面至少一张手机尺寸截图,放在 `docs/pr-screenshots` 分支的 `pr-web-mobile/` 下(沿用既有做法,该分支不合并),PR 描述里引用。
- ADR:不需要。迁移:无。风险:低(界面)。
- 验收:上述页面在 360 / 390 / 430 px 宽度下无横向滚动、无被截断的按钮或输入框;手机视口冒烟通过;桌面布局的现有 Playwright 用例不变;CI 全绿。真机(iOS Safari、Android Chrome)的软键盘与安全区表现列入业主清单(第 4 节)。

### PR 4 · `docs/deploy-docker`

- 目标文件(预计):
  - `docs/deploy/docker.md` 与 `docs/deploy/docker.en.md`(中英;英文先由模型翻译,标注「待校对」):适用场景、机器要求、步骤、升级、备份与恢复、排错。
  - `docker/docker-compose.prod.yml`:服务 `fatcat-ai`(镜像取自第 5 节问题 4 定的地址;`mem_limit` 与 `NODE_OPTIONS` 按 2 GB 机器给出推荐值)+ `caddy`;数据卷、Caddy 数据卷;`FATCAT_MASTER_KEY_FILE` 用 Docker secret 或只读挂载文件(ADR 0026),不放进 compose 明文环境变量。
  - `docker/caddy/Caddyfile.example`:自动 HTTPS(Let's Encrypt HTTP-01 / TLS-ALPN-01 的最简写法)、反向代理到 `fatcat-ai:8787`、WebSocket 与 SSE 需要的超时与缓冲设置(流式对话与实时事件)、基本安全响应头。
  - `docker/caddy/Dockerfile.dnspod` 与对应 Caddyfile 示例:用 `xcaddy` 构建带 DNSPod DNS 插件的 Caddy,用于「服务器在内网或 80/443 不通,用 DNS-01 验证」。插件的许可证、维护状态与依赖需先核实;它是单独的部署镜像,不进本项目依赖,也不会进 `pnpm-lock.yaml`,但仍要在文档里写明来源与版本固定方式。
- 内容要点:
  - **2 GB 内存机器的配置建议**:应用容器 512 MiB 上限的依据(ADR 0018:空闲 ≤ 250 MiB,对话峰值 < 400 MiB)、Caddy 约 30–50 MiB、给系统与 SQLite 页缓存留的余量、是否需要 swap、邮件同步与文档解析子进程不计入空闲值但计入容器上限。数字以 PR 5 的实测为准,本 PR 先写推荐并标明待 PR 5 回填。
  - **暴露到公网前的必做项**(来自 M5b):开启 TOTP(ADR 0027)、把 `secrets.yaml` 迁移为加密(ADR 0026)并备份主密钥、只暴露 Caddy 的 80/443、应用容器不发布端口、设置页的外连目标清单核对(ADR 0028)。没有完成 TOTP 与密钥加密,文档不推荐对公网开放(开发计划 M5b)。
  - 备份与恢复(数据卷、主密钥分开保存)、升级(换镜像标签、数据迁移前备份)、日志位置(只写本地)、`server.lock` 残留的处理(M5b 的 `secrets` CLI 报错提示)。
  - AGPL §13:修改版部署者设置 `FATCAT_AI_SOURCE_URL`(现有 compose 已有说明)。
- 测试:
  - 在 CI 里增加一个**不依赖域名的部署冒烟**:起 compose 的生产文件,Caddy 用 `tls internal`(自签)或只监听 HTTP 的测试变体,断言经 Caddy 能取到 `/healthz` 与首页,WebSocket / SSE 经代理能连通;不访问公网、不申请证书。
  - `docker compose config` 校验、Caddyfile 用 `caddy validate`。
  - 文档里的每条命令要在本地容器里实际跑过一遍并贴结果;DNSPod 与真实域名的部分无法在 CI 或云容器里验证,明确列入业主清单。
- ADR:需要时写 `docs/adr/0031-deployment.md`(反向代理责任边界、哪些头由 Caddy 加、哪些由应用加、信任代理头的配置);若 PR 里没有新决定则不写。迁移:无。风险:中(对外暴露、密钥处理);**涉及密钥与对外暴露的改动在描述最上面标出**。
- 验收:文档步骤能在一台干净机器上从零走通(命令逐条验证过);CI 的部署冒烟通过;不带域名的测试没有任何公网访问;开发计划 M5c 验收的 2C2G 实机验证列入清单(第 4 节)。

### PR 5 · `release/v1.0-prep`

- **GHCR 镜像构建**(`.github/workflows/release.yml`):
  - 多架构(`linux/amd64`、`linux/arm64`),用 Buildx + QEMU;`SOURCE_URL`、`VERSION` 构建参数传入(`Dockerfile` 已有),带 OCI 标签。
  - 触发方式:`workflow_dispatch`(带 `push` 布尔输入,默认 `false`)与 `v*` tag。**没有 tag、没有人手动选择 `push: true`,就只构建不推送。**PR 上跑「只构建不推送」的演练(amd64 全量、arm64 至少构建到最后一层,时间过长则在 main 上跑),确认 arm64 能构建通过。
  - 推送到 GHCR 时用 `GITHUB_TOKEN`(`packages: write`),不新增长期凭据;标签策略(`1.0.0`、`1.0`、`1`、`latest`、`sha-<7>`)写在文档里,**本 PR 不执行任何推送**。
  - 构建产物的供应链信息(SBOM、provenance、cosign 签名)见第 5 节问题 5;推荐 1.0 只做 provenance/SBOM 的构建输出,cosign 留到 1.0.x,因为第 16 节第 5 条的「校验和 + cosign」针对桌面包。
- **内存基线更新**(ADR 0018):在 main 上跑 `memory-load.yml`(空闲基线 + 万封同步 + 微信增量,至少 3 次),取实测值写回 `.github/memory-baseline.json`(`idleRssMiB`、`commit`、`measuredAt`、`channelIncrementMiB.wechat` 视实测是否变化),并与 v1.0 前的 111 MiB 比较涨幅(规则 2:超过 10% 报警、超过 20% 失败);更新理由写进 PR 描述与 ADR 0018 的第 3 节。**对话中的峰值 < 400 MiB**(开发计划第 11 节)也在这一 PR 里测:用 `pnpm perf` 现有脚本或新增一条,在 Docker 镜像里跑一轮含工具调用与长回复的对话并记录峰值。云容器上的测量只作参考,2C2G 实机的数字列入业主清单。
- **v1.0 Release Notes 草稿**:`docs/release/v1.0-notes.md`(中文)与 `docs/release/v1.0-notes.en.md`(英文,待校对):1.0 做了什么(按 M1–M5b 的用户可见变化整理,取自 `CHANGELOG.md`)、已知限制(只有微信渠道、企业微信推迟、单用户、粒子球在 M10、Windows 与真实服务的验证范围)、安全说明(TOTP、密钥加密、默认监听 127.0.0.1)、升级与迁移提示、**推荐的模型组合留空,标注「待业主确认」**(第 5 节问题 3)。这是仓库里的草稿文件,**不是 GitHub Release**,不创建 Release。
- **README 快速开始**:`README.md` 与 `README.en.md` 的「快速开始」改为以 Docker(`docker compose up -d`)为主,本地开发(`pnpm dev`)为次;指向 PR 4 的部署文档;列出首次登录、添加模型配置档、(可选)绑定微信的步骤;不写尚未确认的模型组合,只写「用任何 OpenAI 兼容端点或本地 Ollama」。`CHANGELOG.md` 把 `[Unreleased]` 整理成 `1.0.0` 草稿段落但**不写发布日期**,保持 `Unreleased` 标题直到业主确认发布。
- **版本号**:各 `package.json` 的 `version` 仍为 `0.0.0`,是否在发布时统一设为 `1.0.0` 见第 5 节问题 7;本 PR 不改。
- **M5c 自检报告**:`docs/milestones/M5c-self-check.md`,结构沿用 M5b 的自检(逐 PR 表、验收逐条对照、业主真机清单、推迟项去向)。验收对照来自开发计划 M5c 一节(第 4 节)。
- ADR:内存基线更新写进 ADR 0018;若发布流程有新决定(标签策略、签名),写 `docs/adr/0032-release.md`。迁移:无。风险:**高(发布、镜像、基线)**;所有会影响对外发布的地方在描述最上面标出。
- 验收:发布工作流在「不推送」模式下跑通 amd64 与 arm64;草稿与 README 内容与事实一致(逐条在自检里核对);基线文件与 `memory-load.yml` 的实测一致;**仓库里没有 `v1.0*` tag、没有 Release、GHCR 上没有新镜像**(PR 描述里附 `git tag -l` 与 GHCR 状态说明);CI 全绿。

## 3. 1.0 渠道范围订正(随本 PR)

业主 2026-11-16 决定:第 16 节第 3 条由「1.0 只做企业微信 + 微信」改为「1.0 只含微信,企业微信推迟、排期另定」。本 PR 已订正:

| 文件                              | 位置                                | 改动                                                                                               |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docs/plan/FatCat-AI-开发计划.md` | 第 16 节第 3 条                     | 改为「1.0 只含微信;企业微信推迟、排期另定(重新开始前先写 ADR 修订 ADR 0022 第 11 节);QQ 之后再做」 |
| 同上                              | 第 16 节末尾摘要(第 758 行)         | 同步                                                                                               |
| 同上                              | 第 13 节第 7 条(第 571 行)          | 同步                                                                                               |
| 同上                              | 第 2 节渠道表、架构图、里程碑一句话 | 去掉「1.0 有企业微信」                                                                             |
| 同上                              | M5 / M5a 标题与 M5a 验收            | 标题去掉企业微信;验收改为「微信渠道可收发并完成一次审批(企业微信推迟)」                            |
| 同上                              | 风险表「个人微信渠道政策变化」      | 把「1.0 企业微信为主备」改为「企业微信推迟,微信不可用时 Web UI 与 CLI 仍是完整入口」               |
| `README.md`、`README.en.md`       | 渠道一行                            | 「1.0 支持微信(企业微信推迟,排期另定)」                                                            |
| `AGENTS.md`                       | 第 7 条                             | 同步第 16 节写法                                                                                   |

核对过且不改的:ADR 0018 第 5 节表格里的「企业微信 | 推迟」、ADR 0022 与 ADR 0028 里的「企业微信推迟」、M5a / M5b 方案与自检里的推迟说明、开发计划第 3 节与记忆补充设计里关于 2.0 小团队或群聊过滤的企业微信说法(不是 1.0 范围声明)。`CLAUDE.md` 中没有渠道范围的说法。

## 4. 验收对照(开发计划 M5c)

| 开发计划验收项 / 条目                                                                 | 对应 PR | 谁验证                             |
| ------------------------------------------------------------------------------------- | ------- | ---------------------------------- |
| 冻结前复核 oasdiff 覆盖 `/api/v1` 全部路径                                            | PR 2    | CI(覆盖测试)                       |
| CI 补上 CodeQL 或 Semgrep                                                             | PR 2    | CI                                 |
| Web UI 响应式适配手机                                                                 | PR 3    | CI(手机视口冒烟)+ 业主真机         |
| Docker 一键部署文档(2 GB、Caddy 自动 HTTPS、DNSPod 示例)                              | PR 4    | CI(无域名的部署冒烟)+ 业主真实域名 |
| Docker 镜像(amd64 / arm64)到 GHCR                                                     | PR 5    | CI 只验证构建;**推送需业主确认**   |
| v1.0 Release Notes                                                                    | PR 5    | 草稿由 C 写,**业主确认后才发布**   |
| README 快速开始                                                                       | PR 5    | 业主按文档走一遍                   |
| 按 ADR 0018 把内存基线更新为实测值                                                    | PR 5    | CI(`memory-load.yml`)              |
| **验收**:2C2G 机器 `docker compose up -d` 后经 HTTPS 域名登录使用                     | PR 4、5 | **业主**(真实机器与域名)           |
| **验收**:空闲 ≤ 250 MiB、渠道增量不超上限、同步后回落、涨幅 ≤ 20%、对话峰值 < 400 MiB | PR 5    | CI + 业主在 2C2G 上复测            |

**留给业主的真机清单**(C 不做,也不碰真实邮箱、`C:\Users\86181\.fatcat-ai` 里的真实数据或真实微信账号):

1. 一台 2C2G 的 Linux 机器、一个真实域名:按部署文档走通 `docker compose up -d`,经 HTTPS 登录。
2. DNSPod 的 API 凭据与 DNS-01 验证(PR 4 的示例)。
3. iOS Safari 与 Android Chrome 上的 Web UI:登录、聊天、软键盘、审批卡片、知识地图下钻、TOTP 输入。
4. 真实验证器 App 的 TOTP 开启与登录。
5. 真实微信账号的收发与审批(M5a、M5b 清单里已有的项继续有效)。
6. Windows 真机:`pnpm dev` 与数据目录(M4、M5a、M5b 自检里列的项继续有效)。
7. 2C2G 实机上的内存读数(空闲、万封同步后、对话峰值)。
8. 发布决定:是否打 tag、创建 Release、向 GHCR 推正式标签。

## 5. 待业主决定的问题(每条先写推荐;不回复就按推荐做,例外见下)

1. **代码扫描选 CodeQL 还是 Semgrep?** 推荐 **CodeQL**:官方维护、与 GitHub 的代码扫描页集成、对 TypeScript 的数据流分析较强、不引入第三方规则许可问题。前提是仓库为公开,或已开通代码扫描;PR 2 开始时先核实,不满足就改用 Semgrep 开源规则集以容器运行。
2. **扫描失败时是否阻塞合并?** 推荐:首次扫描的结果分类处理后,CodeQL 对「高危及以上」设为必需检查前,先观察 1 周的误报率;PR 2 本身只加工作流,不改 main 的保护规则(C 不改保护规则,需要业主在 GitHub 设置里勾选)。
3. **最终的模型组合(默认推荐的对话、廉价、嵌入、语音模型)由谁定?** 必须由**业主确认**,C 不自己定。Release Notes 与 README 里这一处留空并标注「待业主确认」。现有的手测端点(DeepSeek、SiliconFlow)只是测试用的,不等于推荐。
4. **镜像地址与可见性。** 推荐 `ghcr.io/codinglossy/fatcat-ai`,包可见性公开(与开源一致);PR 5 的工作流在业主确认前不推送。如果以后仓库换组织,地址会变,文档里用变量写。
5. **镜像签名与供应链信息。** 推荐 1.0 只输出 provenance 与 SBOM(构建器自带),cosign 签名留到 1.0.x(桌面包阶段统一做,第 16 节第 5 条)。
6. **compose 卷名 `ai-personal-data`。** 现有开发用 compose 里的卷名还是旧名;改名会让已经在跑的部署「丢」数据(实际是找不到旧卷)。推荐:生产用 compose 用新卷名 `fatcat-ai-data`,并在升级说明里给出一条把旧卷内容拷过来的命令;开发用 compose 保持不动,避免打断现有用户。
7. **版本号。** 推荐发布当天由业主确认后,一个单独的 PR 把所有 `package.json` 与 `SERVER_VERSION` 设为 `1.0.0`,与 tag 对应;本方案内的 PR 都不改版本号。
8. **手机适配的形态。** 推荐沿用现有响应式 CSS(不做 PWA 离线安装);PWA(可安装、离线壳)留到 M11 之前讨论,因为 service worker 会引入缓存与更新的复杂度。
9. **DNSPod 插件的来源。** 推荐用社区维护的 Caddy DNS 插件并在文档里固定版本,明确写「示例,不保证长期可用」;如果插件许可证或维护状况不合格,只保留 HTTP-01 的路线并把 DNSPod 示例改为用 `acme.sh` / `lego` 手动取证书的方案。

**需要业主明确同意才能做**(不会因为不回复而自动执行):合并、打 tag / 发 Release、向 GHCR 推送正式标签、改动数据目录或真实数据、发信、改 main 的保护规则。

## 6. 推迟项

- 企业微信:业主 2026-11-16 决定继续推迟,不在 1.0;排期另定;重新开始前先写 ADR 修订 ADR 0022 第 11 节(不需要登录的回调接口,带「先验签再解密」清单)。
- 粒子球导航 `KnowledgeSphere` → M10(第 16 节)。
- PWA / 离线安装、桌面与手机客户端 → M10、M11。
- 镜像 cosign 签名(第 5 节问题 5)→ 1.0.x。
- 定时推送到渠道 → M6。
- 多用户、TOTP 多账户 → 2.0。
- 更新检查:代码中不存在;将来加入时必须登记进外连清单(ADR 0028)。
- 邮件 `List-Id` 排除:邮件缓存没有 `List-Id`,见 M5b PR #37 的收尾项。

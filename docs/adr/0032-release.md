# ADR 0032 · 发布流程:镜像构建、标签与「不推送」默认

- 状态:提议(M5c PR 5 `release/v1.0-prep`)
- 日期:2026-11-16
- 相关:ADR 0018(内存预算)、ADR 0030(API v1 冻结)、ADR 0031(部署)、M5c 方案 PR 5
- 依据:开发计划 M5c「Docker 镜像(amd64 / arm64)到 GHCR」;业主要求:发布前不打 tag、不发 Release、不向正式标签推送镜像。

## 决定

### 1. 工作流默认只构建

`.github/workflows/release.yml`:

- 每个平台(amd64、arm64)在各自的原生 runner(`ubuntu-latest`、`ubuntu-24.04-arm`)上完整构建 `docker/Dockerfile`,启动镜像检查 `/healthz` 与架构,**不登录、不推送**。选原生 runner 而不是 QEMU:arm64 在 QEMU 下的 `pnpm install` 与 Vite 构建慢一个数量级,而演练要的是「真的能构建到最后一层」。
- `publish` 任务只在两种情况下存在:推送了 `v*` tag,或手动触发且 `push` 输入为 `true`。其余情况(包括所有 PR 和 main 上的推送)被 `if` 跳过。手动推送只产生 `sha-<7>` 标签,不会产生 `latest` 或版本号标签。
- 推送用 `GITHUB_TOKEN`(`packages: write`,只给 `publish` 任务),不新增长期凭据。发布镜像用 QEMU 多平台构建一次,附带 provenance(`mode=max`)与 SBOM。
- 标签策略见 `docs/release/image-tags.md`。cosign 签名推迟到 1.0.x。

### 2. 发布的人工关口

打 `v*` tag、创建 GitHub Release、手动 `push=true`、把版本号改为 1.0.0、填写 ADR 0030 的冻结日期与哈希,都由业主决定并动手。`scripts/check-no-release.mjs` 是只读核对:仓库没有 `v*` tag、没有 Release、GHCR 上没有该镜像的标签。

### 3. 内存基线

ADR 0018 第 3 节的基线在发布时改为实测值(见该 ADR)。对话峰值(< 400 MiB,开发计划第 11 节)用 `scripts/perf/chat-peak.mjs` 在镜像里测:假模型先返回 `calc` 工具调用,拿到结果后流式返回约 40 KiB 的长回复,10 个会话各 3 轮,每 200 ms 读一次容器主进程的 VmRSS。它不进 CI(需要 docker 与 host 网络别名),发布前手动跑,数字写进自检报告。

## 后果

- 误触发的概率低:PR 与 main 上的任何事件都不会推送;推送要么需要一个 tag,要么需要有人在 Actions 页面勾选 `push`。
- 第一次真实推送还没有发生,所以 `publish` 任务的 QEMU 构建时间、GHCR 包的可见性(需要业主在包设置里改为 Public)和 provenance 附加都未验证,列入自检报告的业主清单。

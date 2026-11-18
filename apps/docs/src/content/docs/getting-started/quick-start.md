---
title: 快速开始
description: 用 Docker 在几分钟内跑起来,或从源码启动。
---

## 用 Docker 启动

需要 Docker 24 或更高(含 Compose v2)。建议 2 GB 以上内存;不配置渠道时空闲约 110 MiB,仅供参考。

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs fatcat-ai | grep -i 'setup code'   # 取一次性设置码
```

1. **首次登录**:打开 <http://127.0.0.1:8787>,按提示创建主人账户(1.0 只有一个账户),「设置码」填日志里的那串字符。
2. **添加模型配置档**:「设置 → 模型配置档」,见[配置模型](/FatCat-AI/getting-started/models/)。看到「密钥: 已设置」后就可以开始对话。
3. **(可选)绑定微信**:「设置 → 渠道」添加微信渠道并扫码。1.0 只含微信渠道,企业微信推迟。
4. **要放到公网**:不要直接暴露 8787 端口,按 [Docker 部署指南](/FatCat-AI/guides/docker/)用 Caddy 自动 HTTPS,并先开启两步验证和密钥文件加密。

:::note
预构建镜像(GHCR,amd64 / arm64)在 1.0 正式发布后提供;发布前请用上面的 `--build` 从源码构建。
:::

## 从源码启动

需要 Node.js 24 LTS 或更高版本与 pnpm 10(`corepack enable` 即可启用)。

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
export DEEPSEEK_API_KEY='<你的密钥>'   # 以 DeepSeek 为例;本地 Ollama 不需要密钥
pnpm dev
```

- 服务器:<http://127.0.0.1:8787/healthz>;Web 界面:<http://127.0.0.1:5173>。
- Windows PowerShell 用 `$env:DEEPSEEK_API_KEY = '<你的密钥>'`。
- 默认数据目录是 `~/.fatcat-ai`(Windows 为 `%USERPROFILE%\.fatcat-ai`),可用 `FATCAT_AI_DATA_DIR` 修改。

## 命令行客户端

不用网页也能配置和对话(先 `pnpm build`,再在仓库根目录用 `node apps/cli/dist/bin.js …` 代替下面的 `fatcat-ai`):

```bash
fatcat-ai setup -u owner
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "用三句话解释 AGPL 第 13 条"
fatcat-ai chat
```

## 桌面应用

桌面应用在 M10 提供,发布后这里会补充安装说明。

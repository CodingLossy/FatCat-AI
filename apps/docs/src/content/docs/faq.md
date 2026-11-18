---
title: 常见问题
description: 安装、登录、密钥和部署中最常遇到的问题。
---

## 打开 `http://127.0.0.1:8787/` 是 404

本地开发时核心服务器默认不托管网页:用 `pnpm dev` 时访问 5173 端口。要让 8787 也提供网页,构建后设置环境变量 `FATCAT_AI_WEB_DIR` 指向 `apps/web/dist`。Docker 镜像已经配置好,直接访问 8787。

## 创建账户时要「设置码」

从别的机器或经过反向代理访问时,必须填启动日志里的一次性设置码(`docker compose … logs fatcat-ai | grep -i 'setup code'`),也可以在 `.env` 里用 `FATCAT_AI_SETUP_CODE` 固定一个。

## 配置档一直显示「密钥: 缺失」

`env:` 引用要求服务器**进程**里有这个环境变量(在终端里设置后,要在同一个终端启动服务器);`file:` 引用要求数据目录的 `secrets.yaml` 里有同名键。Docker 里的写法见 [Docker 部署指南](/FatCat-AI/guides/docker/)。

## 数据放在哪里?怎么备份?

默认在 `~/.fatcat-ai`(Windows 为 `%USERPROFILE%\.fatcat-ai`,Docker 里是 `/data` 卷)。备份前先停止服务(SQLite 使用 WAL,热拷贝可能不一致),主密钥要另外保存。步骤见 Docker 指南第 8 节。

## 丢了验证器和恢复码怎么办?

在服务器所在机器上运行 `node dist/index.js auth reset-totp`(服务停止时),密码不受影响。

## 丢了主密钥会怎样?

加密的密钥文件和两步验证的共享密钥将无法打开。请把主密钥保存在这台机器以外的地方。

## 回复一次性全部出现,不是逐字流出

反向代理缓冲了响应:Caddy 需要 `flush_interval -1`,Nginx 需要 `proxy_buffering off`。

## 为什么没有 OAuth 邮箱登录?

邮箱用 IMAP / SMTP 加应用专用密码或授权码,只保存对它的引用。Gmail 需要先开两步验证再生成应用专用密码;不支持 OAuth。

## 支持企业微信 / QQ 吗?

1.0 只含微信渠道;企业微信推迟、排期另定,QQ 以后再说。

## 用什么许可证?

AGPL-3.0-only,另有商业许可(见仓库的 `COMMERCIAL.md`)。插件 SDK、客户端 SDK 和共享协议包是 Apache-2.0。

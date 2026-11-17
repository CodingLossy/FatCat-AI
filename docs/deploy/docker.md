# Docker 一键部署指南

适用于:一台 2 核 2 GB 内存的 Linux 机器,用 Docker Compose 跑 FatCat-AI,由 Caddy 自动申请和续期 HTTPS 证书。English version: [docker.en.md](docker.en.md).

> 本文的命令都在本地容器里逐条跑过(见文末「验证范围」)。真实域名、真实 DNS 账号和 2C2G 实机没有验证,请按「验证清单」自己核对。

## 1. 先决条件

| 项目     | 要求                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 机器     | Linux,2 核 / 2 GB 内存 / 10 GB 以上磁盘,Docker Engine 24+ 与 Compose v2(`docker compose version`)                               |
| 域名     | 一个能改解析的域名,A(和 AAAA)记录指向本机公网 IP                                                                                |
| 端口     | 80 与 443(TCP),以及 443/UDP(HTTP/3,可选)能从公网访问。80 不通或机器在内网时看第 7 节(DNS-01)                                    |
| 中国大陆 | 大陆的云厂商通常要求域名备案后才放行 80/443,这是厂商的规定,与本项目无关;没有备案的机器请用海外机器,或只在内网 / VPN 里访问      |
| 构建内存 | 第一次要在本机构建镜像(`pnpm build`),2 GB 机器可能内存不足:先临时加 2 GB swap,或在别的机器构建好再导入;发布镜像之后改为拉取镜像 |

## 2. 获取代码

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI/docker
cp .env.example .env
```

编辑 `.env`:

- `FATCAT_AI_DOMAIN`:你的域名,例如 `fatcat.example.com`。
- `ACME_EMAIL`:Let's Encrypt 到期提醒用的邮箱。
- `FATCAT_AI_SETUP_CODE`:首次创建账户用的设置码(至少 8 位)。可以留空,留空时从启动日志里取。例如 `openssl rand -hex 8`。
- `FATCAT_AI_SOURCE_URL`:只有部署修改版时才填你的修改版源码地址(AGPL §13 要求让用户能拿到源码)。

`.env` 已被 `.gitignore` 忽略,不要提交。

## 3. 生成主密钥

主密钥加密 `secrets.yaml`(模型 API Key、微信令牌)和两步验证的共享密钥(ADR 0026)。**丢了主密钥就丢了这些密钥**,所以单独保存,不放进数据备份。

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/master.key
sudo chown 1000:1000 secrets/master.key    # 容器里的 node 用户(uid 1000)要能读
sudo chmod 400 secrets/master.key
```

`secrets/` 已被 `.gitignore` 忽略。同时把 `secrets/master.key` 的内容抄进密码管理器等**不在这台机器上**的地方。启动时报 `FATCAT_MASTER_KEY_FILE cannot be read (EACCES)` 就是这一步的属主或权限不对。

## 4. 启动

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

两个服务都应显示 `Up`,`fatcat-ai` 显示 `healthy`。Caddy 第一次启动会向 Let's Encrypt 申请证书,通常几十秒;看进度:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

出现 `certificate obtained successfully` 后,用浏览器打开 `https://你的域名`。

## 5. 创建账户并加固(暴露到公网前必做)

只有 Caddy 发布端口,应用容器不发布端口。没做完下面几项之前,不要把域名解析给别人用。

1. **创建主人账户**:打开页面按提示填用户名和密码,「设置码」填 `.env` 里的 `FATCAT_AI_SETUP_CODE`;留空的话执行 `docker compose -f docker-compose.prod.yml logs fatcat-ai | grep -i 'setup code'` 取一次性设置码。账户创建后把 `.env` 里的 `FATCAT_AI_SETUP_CODE` 清空并 `docker compose -f docker-compose.prod.yml up -d` 让它生效。
2. **开启两步验证(TOTP)**:设置 → 安全,用验证器 App 扫码,把 10 个恢复码存到安全的地方(ADR 0027)。
3. **加密密钥文件**:先在设置 → 模型配置档里添加配置档;密钥放进数据卷里的 `secrets.yaml`(见下),再在设置 → 密钥点「加密密钥文件」(或停服后用命令行,见第 9 节),确认一切正常后再 `secrets cleanup` 删掉明文迁移文件(ADR 0026)。
4. **核对外连目标**:设置里的外连目标清单(ADR 0028)只应包含你用的模型端点、邮箱服务器等。
5. **确认没有别的入口**:`docker compose -f docker-compose.prod.yml ps` 里 `fatcat-ai` 没有 `PORTS`;`ss -ltnp | grep 8787` 在宿主机上没有监听。

写入模型 API Key(之后在配置档里引用 `file:DEEPSEEK_API_KEY`;换成你的密钥,命令不要留在 shell 历史里,可以在命令前加一个空格或用 `read -s`):

```bash
printf 'DEEPSEEK_API_KEY: "%s"\n' '你的密钥' | \
  docker compose -f docker-compose.prod.yml exec -T fatcat-ai sh -c 'umask 077; cat > /data/secrets.yaml'
```

> 已知限制(ADR 0031 第 3 节):应用不信任 `X-Forwarded-For`,经 Caddy 访问时登录失败限速对所有来源共用一个计数。别人持续猜密码会让你自己暂时(最长一分钟)登不上,但不会让猜密码变容易;两步验证的限速另按用户名计数。

## 6. 2 GB 内存机器的配置

| 部分               | 上限                                                 | 依据                                                                                                                          |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 应用容器           | `mem_limit: 512m`,`memswap_limit: 512m`(不使用 swap) | 空闲 ≤ 250 MiB、对话峰值 < 400 MiB(ADR 0018);镜像里 Node 堆上限 384 MiB;邮件同步和文档解析的子进程不计入空闲值,但计入容器上限 |
| Caddy              | `mem_limit: 128m`                                    | 本地容器空闲时实测约 11 MiB(`docker stats`),有流量与证书操作时会增长,按 30–50 MiB 预留;2C2G 实机数字待发布前回填              |
| 系统与 SQLite 缓存 | 剩余约 1.3 GB                                        | 留给内核、Docker 守护进程和文件缓存                                                                                           |

- 容器超限会被内核杀掉并按 `restart: unless-stopped` 自动重启,而不是拖垮整机。看是否发生过:`docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' $(docker compose -f docker-compose.prod.yml ps -q fatcat-ai)`。
- 这台机器如果还跑别的服务,把它们的内存也算进来;不够时先考虑关掉邮件同步,而不是调大限制。
- swap:运行时不需要。只有第一次构建镜像时才可能需要(第 1 节)。

## 7. 没有公网 80 端口:用 DNSPod 做 DNS-01 验证

DNS-01 通过在域名下写一条临时 TXT 记录来证明域名所有权,不需要公网入站的 80/443,适合机器在内网、80 被封的情况(浏览器仍需要能访问到 443)。这里的示例用腾讯云 DNS(DNSPod)。

> **示例,不保证长期可用。** 使用的是社区维护的 Caddy 插件 `github.com/caddy-dns/tencentcloud`(MIT,依赖同样是 MIT 的 `github.com/libdns/tencentcloud`),在 `docker/caddy/Dockerfile.dnspod` 里用 `xcaddy` 构建,版本固定在 `CADDY_VERSION` 与 `DNS_PLUGIN_VERSION` 两个 ARG 上;它不属于本项目依赖。升级前先看插件的更新记录(选择理由见 ADR 0031 第 5 节)。

1. 在腾讯云控制台创建一个**子账号**,只授予管理这个域名解析的权限(云解析 DNS / DNSPod 的记录读写),生成 API 密钥(SecretId 与 SecretKey)。
2. 写成两个文件。**属主要是 root(0:0),不是 1000**:Caddy 容器以 root 运行,但 compose 去掉了它的全部 capability(只留绑定 80/443 的那一项),root 也就没有绕过文件权限的能力,属主为 1000、权限 400 的文件它读不了,DNS-01 会因 `Permission denied` 失败。

```bash
printf '%s' '你的SecretId'  > secrets/tencentcloud_secret_id
printf '%s' '你的SecretKey' > secrets/tencentcloud_secret_key
sudo chown 0:0 secrets/tencentcloud_secret_id secrets/tencentcloud_secret_key
sudo chmod 400 secrets/tencentcloud_secret_id secrets/tencentcloud_secret_key
```

(主密钥 `secrets/master.key` 相反,是给应用容器的 node 用户读的,属主是 1000。)

3. 叠加 DNSPod 版的 compose 启动:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.dnspod.yml up -d --build
```

`Caddyfile.dnspod.example` 里的 `acme_dns tencentcloud { ... }` 用 `{file./run/secrets/...}` 从只读挂载的文件读密钥,不经过环境变量。域名的解析记录仍要指向本机的(内网或公网)IP,浏览器才能访问。

## 8. 日志、备份、恢复

- **日志**只写本地,JSON 行:`docker compose -f docker-compose.prod.yml logs --tail 100 fatcat-ai`。Docker 自己会累积容器日志,建议在 `/etc/docker/daemon.json` 里设置 `"log-driver": "local"` 或 `"log-opts": {"max-size": "10m", "max-file": "3"}`。
- **备份数据卷**(先停应用,SQLite 是 WAL 模式,热拷贝可能不一致;主密钥另存,不进这个备份):

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker run --rm -v fatcat-ai_fatcat-ai-data:/data:ro -v "$PWD":/backup caddy:2.11-alpine \
  tar czf /backup/fatcat-ai-data-$(date +%F).tgz -C /data .
docker compose -f docker-compose.prod.yml start fatcat-ai
```

- **恢复**(停应用后覆盖数据卷;对一个全新的卷也一样):

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker run --rm -v fatcat-ai_fatcat-ai-data:/data -v "$PWD":/backup:ro caddy:2.11-alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/fatcat-ai-data-日期.tgz -C /data && chown -R 1000:1000 /data'
docker compose -f docker-compose.prod.yml start fatcat-ai
```

恢复后需要原来的主密钥,否则加密的密钥文件和两步验证打不开。

- **Caddy 的证书**在 `caddy-data` 卷里,丢了会重新申请,注意 Let's Encrypt 有频率限制,不要反复删除这个卷。

## 9. 离线命令:密钥与两步验证

下面这些命令必须在应用停止时运行:

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai node dist/index.js secrets migrate
docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai node dist/index.js auth reset-totp
docker compose -f docker-compose.prod.yml start fatcat-ai
```

- **`secrets migrate` 成功后,确认应用正常就立刻运行 `secrets cleanup`**(把上面的 `secrets migrate` 换成 `secrets cleanup`)删除迁移留下的明文文件 `secrets.yaml.migrated`;在此之前它仍是明文,不要长时间留着。
- 换主密钥:新密钥写进一个文件(例如 `secrets/new.key`,权限让容器能读),用 `-v "$PWD/secrets/new.key:/run/new.key:ro"` 挂进去,运行 `... secrets rekey --new-key-file /run/new.key`,成功后用新密钥文件替换 `secrets/master.key` 再启动应用。
- **server.lock**:Docker 里应用被强制终止后,数据卷里可能残留 `server.lock`,命令会报「the server seems to be running」。**确认服务器已停止后**删除它:`docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai rm /data/server.lock`。

## 10. 升级

```bash
cd FatCat-AI && git pull --ff-only
cd docker
# 先按第 8 节备份,再:
docker compose -f docker-compose.prod.yml up -d --build
```

使用已发布的镜像时,在 `.env` 里设置 `FATCAT_AI_IMAGE=ghcr.io/codinglossy/fatcat-ai:标签`,升级时执行 `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`。数据库迁移会在启动时自动运行,运行前自动备份。回滚:换回旧标签并恢复升级前的备份(迁移不可逆,不要只换镜像)。

**从开发用的 compose 迁移**(`docker/docker-compose.yml`,数据卷叫 `ai-personal-data`):生产 compose 使用新卷名 `fatcat-ai_fatcat-ai-data`。先 `docker compose -f docker-compose.yml down`,再创建新卷并拷贝:

```bash
docker volume create fatcat-ai_fatcat-ai-data
docker run --rm -v ai-personal-data:/from:ro -v fatcat-ai_fatcat-ai-data:/to caddy:2.11-alpine \
  sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
```

旧卷不会被改动,确认新部署正常后再自己决定是否删除。

## 11. 排错

| 现象                                           | 原因与处理                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `fatcat-ai` 反复重启,日志 `master_key_invalid` | 主密钥文件属主或权限不对(第 3 节),或内容不是 64 位十六进制 / base64               |
| `required variable ... is missing`             | `.env` 里没设 `FATCAT_AI_DOMAIN` 或 `ACME_EMAIL`,或没有在 `docker/` 目录下运行    |
| Caddy 日志里申请证书失败                       | 域名没解析到本机、80/443 被防火墙或云安全组拦截;改用第 7 节                       |
| 创建账户返回 403                               | 经反向代理必须带设置码(ADR 0031 第 2 节)                                          |
| 登录后马上掉线                                 | 用 HTTP 访问了(生产 compose 的 Cookie 带 `Secure`);必须用 HTTPS                   |
| WebSocket 连不上、实时事件不更新               | 反向代理没有保留 `Host` 头;自己改了 Caddyfile 或换了 Nginx 时检查                 |
| 流式回复最后一次性出现                         | 反向代理缓冲了响应。Caddy 用 `flush_interval -1`;Nginx 需要 `proxy_buffering off` |
| 容器被杀、`OOMKilled` 为 `true`                | 超出 512 MiB 上限:检查是否在做万封级邮件同步,或在这台机器上还跑了别的程序         |

## 12. 验证范围

本地容器里逐条验证过(部署冒烟 `scripts/deploy-smoke.mjs` 在 CI 里每次都跑):`docker compose config`、`caddy validate` / `caddy fmt`(三份 Caddyfile)、经 Caddy 的 `/healthz` 与首页、设置码、令牌、WebSocket ping/pong、SSE 逐块到达(假模型每 600 ms 一块)、主密钥文件权限错误时的报错、`secrets migrate` / `rekey`、数据卷备份与恢复、DNSPod 版 Caddy 的构建与 `caddy validate`。

**没有验证,需要你在真实环境核对**:

1. 2C2G 实机上 `docker compose up -d` 后经真实域名的 HTTPS 登录;Let's Encrypt 真实签发与续期。
2. DNSPod:API 子账号权限、DNS-01 真实签发(云容器里不能访问你的 DNS 账号)。
3. 2C2G 机器上的内存实测(应用与 Caddy 的常驻值),以及第一次本地构建是否需要 swap。
4. 手机浏览器经 HTTPS 登录(Cookie 的 `Secure`)。
5. 英文版 [docker.en.md](docker.en.md) 由模型翻译,待校对。

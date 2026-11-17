# ADR 0031 · Docker 部署:反向代理的责任边界

- 状态:提议(M5c PR 4 `docs/deploy-docker`)
- 日期:2026-11-16
- 相关:ADR 0018(内存预算)、ADR 0026(主密钥)、ADR 0027(TOTP)、ADR 0028(外连清单)、M5c 方案 PR 4
- 依据:开发计划 M5b/M5c「对外部署必须经反向代理 + HTTPS」。

## 背景

应用默认只监听 127.0.0.1,公网部署要放在反向代理后面。需要写清楚谁负责什么,否则文档里的配置会和应用的行为互相打架(重复的响应头、被伪造的来源地址、会话 Cookie 没有 Secure)。

## 决定

### 1. 责任划分

| 事项                                              | 谁负责                          | 说明                                                                                                   |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 证书与 HTTPS、HTTP→HTTPS 跳转、HTTP/3             | Caddy                           | 默认 Let's Encrypt;80/443 不通时用 DNS-01(DNSPod 示例)                                                 |
| 响应头(HSTS、nosniff、X-Frame-Options 等)         | 应用(Hono `secureHeaders`)      | Caddy 不重复添加,避免出现两份头;Caddy 只去掉 `Server`                                                  |
| 压缩                                              | Caddy,仅静态资源                | `/api/` 不压缩,避免缓冲 SSE                                                                            |
| SSE 与 WebSocket 的实时转发                       | Caddy:`flush_interval -1`       | 部署冒烟(`scripts/deploy-smoke.mjs`)用每 600 ms 一块的假模型检查事件不是最后一起到                     |
| 鉴权、CSRF、会话 Cookie、WebSocket 的 Origin 校验 | 应用                            | 反向代理必须保留 `Host` 头(Caddy 默认保留),应用要求 Cookie 鉴权的 WebSocket 里 `Origin` 与 `Host` 一致 |
| Cookie 的 `Secure`                                | 应用,生产 compose 设为 `always` | 不依赖 `X-Forwarded-Proto`                                                                             |
| 端口                                              | compose                         | 只有 Caddy 发布 80/443;应用容器不发布端口                                                              |

### 2. 不信任代理头

应用不读取 `X-Forwarded-For`,来源地址取 TCP 对端地址(`apps/server/src/app.ts` 的 `clientIp`);带有 `X-Forwarded-For`、`Forwarded`、`X-Real-IP` 之一的请求一律不算「本机直连」,所以经 Caddy 创建主人账户必须带设置码(生产 compose 里 `FATCAT_AI_SETUP_CODE` 或启动日志里的一次性设置码)。Caddy 默认会丢弃客户端自己带来的 `X-Forwarded-*` 并重写,Caddyfile 里不要加 `trusted_proxies`。

### 3. 已知限制:登录限速按「对端地址」计数

经 Caddy 访问时,应用看到的对端地址永远是 Caddy 容器的地址,于是密码登录的失败限速(每分钟 5 次,`FailureLimiter`)对所有访客是同一个计数:有人持续猜密码会让主人本人也暂时登不上(最长一分钟一轮),但不会让猜密码更容易;TOTP 的限速另按用户名计数(ADR 0027 第 5 节),不受此影响。1.0 只有单个主人账户,影响面可接受,所以本 PR 不改应用代码。

**待业主决定**:是否在 1.0 后的补丁里加一个显式开启的「可信代理」配置(例如 `FATCAT_AI_TRUSTED_PROXY=<地址段>`,只有对端地址落在该段内才读取 `X-Forwarded-For` 最右一项),让限速按真实来源地址计数。推荐做,但它是安全相关的行为变化,需要单独的 PR、ADR 与越权用例,不夹在文档 PR 里。

### 4. 密钥文件

主密钥只通过 Docker secret(`file:` 来源,运行时是只读挂载在 `/run/secrets/fatcat_master_key`)传入,`FATCAT_MASTER_KEY_FILE` 指向它;不使用 `FATCAT_MASTER_KEY` 环境变量(`docker inspect` 能看到)。容器里运行用户是 `node`(uid 1000),宿主机上的密钥文件必须能被它读取:`chown 1000:1000` 并 `chmod 400`;读不了时应用启动报 `master_key_invalid`。腾讯云 API 密钥同样用 secret 文件,Caddyfile 里用 `{file./run/secrets/...}` 读取,不进环境变量。

### 5. DNSPod 插件

- 选用 `github.com/caddy-dns/tencentcloud`(MIT,依赖 `github.com/libdns/tencentcloud`,MIT;2025-11 仍有发布,使用腾讯云新版 API 的 SecretId / SecretKey,支持按子账号授权)。
- 没有选 `caddy-dns/dnspod`:它基于旧版 DNSPod token 接口,最后一次发布是 2022 年,不支持权限拆分。
- 它是单独的部署镜像(`docker/caddy/Dockerfile.dnspod`),`xcaddy` 构建,版本固定在 `CADDY_VERSION` 与 `DNS_PLUGIN_VERSION` 两个 ARG;不进 `package.json` 与 `pnpm-lock.yaml`,CI 不构建它(需要联网下载 Go 模块),`pnpm check:licenses` 也不覆盖它,文档里写明来源、许可证和固定方式。示例,不保证长期可用。

## 后果

- 部署文档(`docs/deploy/docker.md`)、生产 compose 与 Caddyfile 都以本 ADR 为准;改动其中一处要同步其他处。
- CI 增加不依赖域名的部署冒烟:HTTP 测试变体(`Caddyfile.test`)、假模型、占位密钥,不申请证书、不访问公网。

# Docker one-click deployment guide

> Machine-translated from [docker.md](docker.md); **pending proofreading**.

For a 2-core / 2 GB Linux machine running FatCat-AI with Docker Compose, with Caddy getting and renewing the HTTPS certificate automatically.

> Every command here was run in a local container (see "What was verified" at the end). A real domain, a real DNS account and a real 2C2G machine were **not** used; check those yourself.

## 1. Prerequisites

| Item        | Requirement                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine     | Linux, 2 cores / 2 GB RAM / 10 GB+ disk, Docker Engine 24+ with Compose v2 (`docker compose version`)                                                                                                                 |
| Domain      | A domain whose DNS you control, with A (and AAAA) records pointing to this machine's public IP                                                                                                                        |
| Ports       | 80 and 443 (TCP), and 443/UDP (HTTP/3, optional), reachable from the internet. If 80 is blocked or the machine is on a private network, see section 7                                                                 |
| First build | The first start builds the image on the machine (`pnpm build`), which may run out of memory on 2 GB: add 2 GB of temporary swap, or build elsewhere and import the image. Once an image is published, pull it instead |

## 2. Get the code

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI/docker
cp .env.example .env
```

Edit `.env`:

- `FATCAT_AI_DOMAIN`: your domain, for example `fatcat.example.com`.
- `ACME_EMAIL`: the address Let's Encrypt uses for expiry notices.
- `FATCAT_AI_SETUP_CODE`: the setup code for creating the first account (8+ characters, for example `openssl rand -hex 8`). Leave it empty to read a one-time code from the startup log instead.
- `FATCAT_AI_SOURCE_URL`: only if you deploy a modified version: the URL of your modified source (AGPL section 13).

`.env` is git-ignored; never commit it.

## 3. Create the master key

The master key encrypts `secrets.yaml` (model API keys, WeChat tokens) and the two-factor shared secret (ADR 0026). **Losing it means losing those secrets**, so keep a copy that is not part of the data backup.

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/master.key
sudo chown 1000:1000 secrets/master.key    # the container's node user (uid 1000) must be able to read it
sudo chmod 400 secrets/master.key
```

`secrets/` is git-ignored. Also store the key somewhere **off this machine**, such as a password manager. `FATCAT_MASTER_KEY_FILE cannot be read (EACCES)` at startup means the owner or mode is wrong.

## 4. Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Both services should be `Up`, and `fatcat-ai` `healthy`. The first start asks Let's Encrypt for a certificate, usually within a minute:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

After `certificate obtained successfully`, open `https://your-domain`.

## 5. Create the account and harden (required before exposing it)

Only Caddy publishes ports; the app container publishes none. Do not hand the domain to anyone until the steps below are done.

1. **Create the owner account**: fill in a username and password, and the setup code from `.env` (or the one-time code from `docker compose -f docker-compose.prod.yml logs fatcat-ai | grep -i 'setup code'`). Afterwards clear `FATCAT_AI_SETUP_CODE` in `.env` and run `docker compose -f docker-compose.prod.yml up -d`.
2. **Turn on two-factor authentication (TOTP)**: Settings → Security; scan with an authenticator app and keep the 10 recovery codes safe (ADR 0027).
3. **Encrypt the secrets file**: add a model profile first (keys go in `secrets.yaml`, see below), then Settings → Secrets → "Encrypt secrets file" (or the CLI in section 9). After checking that everything works, run `secrets cleanup` to delete the plaintext leftover (ADR 0026).
4. **Review the egress target list** in Settings (ADR 0028): it should only contain the model endpoints, mail servers and so on that you use.
5. **Check there is no other entry point**: `fatcat-ai` shows no `PORTS` in `docker compose ... ps`, and nothing listens on 8787 on the host (`ss -ltnp | grep 8787`).

Write a model API key (then reference it as `file:DEEPSEEK_API_KEY` in the profile; keep the command out of your shell history):

```bash
printf 'DEEPSEEK_API_KEY: "%s"\n' 'your-key' | \
  docker compose -f docker-compose.prod.yml exec -T fatcat-ai sh -c 'umask 077; cat > /data/secrets.yaml'
```

> Known limitation (ADR 0031 section 3): the app does not trust `X-Forwarded-For`, so behind Caddy the password-login failure limiter counts all visitors as one source. Someone guessing passwords can lock you out for up to a minute at a time, but it does not make guessing easier; the TOTP limiter also counts per username.

## 6. Sizing for a 2 GB machine

| Part              | Limit                                              | Basis                                                                                                                                                                           |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App container     | `mem_limit: 512m`, `memswap_limit: 512m` (no swap) | Idle ≤ 250 MiB, chat peak < 400 MiB (ADR 0018); Node heap cap 384 MiB in the image. Mail sync and document-parsing subprocesses count against the container limit               |
| Caddy             | `mem_limit: 128m`                                  | About 11 MiB idle measured in a local container (`docker stats`); it grows with traffic and certificate work, so reserve 30–50 MiB. 2C2G numbers to be filled in before release |
| System and caches | the remaining ~1.3 GB                              | Kernel, Docker daemon and file cache                                                                                                                                            |

- A container over its limit is killed and restarted by `restart: unless-stopped` instead of taking the machine down. Check: `docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' $(docker compose -f docker-compose.prod.yml ps -q fatcat-ai)`.
- If the machine runs other services, count their memory too; turn off mail sync before raising the limit.
- Swap is not needed at run time, only possibly for the first image build.

## 7. No public port 80: DNS-01 with DNSPod

DNS-01 proves domain ownership with a temporary TXT record, so no inbound port 80/443 is needed for issuance (browsers still need to reach 443). The example uses Tencent Cloud DNS (DNSPod).

> **An example with no long-term guarantee.** It uses the community Caddy plugin `github.com/caddy-dns/tencentcloud` (MIT, built on the MIT `github.com/libdns/tencentcloud`), built with `xcaddy` in `docker/caddy/Dockerfile.dnspod` and pinned by the `CADDY_VERSION` and `DNS_PLUGIN_VERSION` build args. It is not a dependency of this project. Read the plugin's changelog before upgrading (why this plugin: ADR 0031 section 5).

1. In the Tencent Cloud console create a **sub-account** limited to managing this domain's DNS records, and generate an API key (SecretId and SecretKey).
2. Write them to two files. **The owner must be root (0:0), not 1000**: the Caddy container runs as root, but the compose file drops all of its capabilities (keeping only the one for binding 80/443), so root cannot bypass file permissions and a file owned by 1000 with mode 400 is unreadable, making DNS-01 fail with `Permission denied`.

```bash
printf '%s' 'your-SecretId'  > secrets/tencentcloud_secret_id
printf '%s' 'your-SecretKey' > secrets/tencentcloud_secret_key
sudo chown 0:0 secrets/tencentcloud_secret_id secrets/tencentcloud_secret_key
sudo chmod 400 secrets/tencentcloud_secret_id secrets/tencentcloud_secret_key
```

(The master key `secrets/master.key` is the opposite: the app container's `node` user reads it, so its owner is 1000.)

3. Start with the DNSPod overlay:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.dnspod.yml up -d --build
```

`Caddyfile.dnspod.example` reads the keys from the read-only mounted files with `{file./run/secrets/...}`, never from environment variables. The domain's A record still has to point at the machine so browsers can reach it.

## 8. Logs, backup, restore

- **Logs** are local JSON lines: `docker compose -f docker-compose.prod.yml logs --tail 100 fatcat-ai`. Docker itself accumulates container logs; set `"log-driver": "local"` or `"log-opts": {"max-size": "10m", "max-file": "3"}` in `/etc/docker/daemon.json`.
- **Back up the data volume** (stop the app first: SQLite runs in WAL mode and a hot copy can be inconsistent; keep the master key separately):

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker run --rm -v fatcat-ai_fatcat-ai-data:/data:ro -v "$PWD":/backup caddy:2.11-alpine \
  tar czf /backup/fatcat-ai-data-$(date +%F).tgz -C /data .
docker compose -f docker-compose.prod.yml start fatcat-ai
```

- **Restore** (stop the app; works on a fresh volume too):

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker run --rm -v fatcat-ai_fatcat-ai-data:/data -v "$PWD":/backup:ro caddy:2.11-alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/fatcat-ai-data-DATE.tgz -C /data && chown -R 1000:1000 /data'
docker compose -f docker-compose.prod.yml start fatcat-ai
```

You need the original master key after a restore, or the encrypted secrets and two-factor secret cannot be opened.

- **Caddy's certificates** live in the `caddy-data` volume. Deleting it means re-issuing; Let's Encrypt has rate limits, so don't delete it repeatedly.

## 9. Offline commands: secrets and two-factor

These must run while the app is stopped:

```bash
docker compose -f docker-compose.prod.yml stop fatcat-ai
docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai node dist/index.js secrets migrate
docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai node dist/index.js auth reset-totp
docker compose -f docker-compose.prod.yml start fatcat-ai
```

- **After `secrets migrate` succeeds and the app works, run `secrets cleanup` right away** (replace `secrets migrate` with `secrets cleanup` above) to delete the plaintext leftover `secrets.yaml.migrated`; until then it is still plaintext, so don't leave it around.
- Rotate the master key: write the new key to a file (for example `secrets/new.key`, readable by the container), mount it with `-v "$PWD/secrets/new.key:/run/new.key:ro"`, run `... secrets rekey --new-key-file /run/new.key`, then replace `secrets/master.key` with the new key before starting the app.
- **server.lock**: after the app is killed hard, a stale `server.lock` can stay in the volume and the commands report "the server seems to be running". **Once you have confirmed the server is stopped**, delete it: `docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai rm /data/server.lock`.

## 10. Upgrade

```bash
cd FatCat-AI && git pull --ff-only
cd docker
# back up first (section 8), then:
docker compose -f docker-compose.prod.yml up -d --build
```

With a published image, set `FATCAT_AI_IMAGE=ghcr.io/codinglossy/fatcat-ai:TAG` in `.env` and upgrade with `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`. Database migrations run on startup, with an automatic backup first. To roll back, switch back to the old tag and restore the pre-upgrade backup (migrations are not reversible, so changing only the image is not enough).

**Moving from the development compose file** (`docker/docker-compose.yml`, volume `ai-personal-data`): the production compose uses the new volume `fatcat-ai_fatcat-ai-data`. Run `docker compose -f docker-compose.yml down`, then copy:

```bash
docker volume create fatcat-ai_fatcat-ai-data
docker run --rm -v ai-personal-data:/from:ro -v fatcat-ai_fatcat-ai-data:/to caddy:2.11-alpine \
  sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
```

The old volume is left untouched; delete it yourself once the new deployment works.

## 11. Troubleshooting

| Symptom                                             | Cause and fix                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fatcat-ai` restarts, log says `master_key_invalid` | Wrong owner/mode on the key file (section 3), or the content is not 64 hex characters / base64          |
| `required variable ... is missing`                  | `FATCAT_AI_DOMAIN` or `ACME_EMAIL` not set in `.env`, or you are not in the `docker/` directory         |
| Caddy cannot get a certificate                      | DNS not pointing at the machine, or 80/443 blocked by a firewall or cloud security group; use section 7 |
| Creating the account returns 403                    | Behind a reverse proxy the setup code is required (ADR 0031 section 2)                                  |
| Signed out right after login                        | You used HTTP; the session cookie is `Secure` in the production compose. Use HTTPS                      |
| WebSocket fails, live events do not update          | The proxy does not preserve the `Host` header (check custom Caddyfiles or Nginx)                        |
| Streamed replies appear all at once                 | The proxy buffers responses: Caddy needs `flush_interval -1`; Nginx needs `proxy_buffering off`         |
| Container killed, `OOMKilled` is `true`             | Over the 512 MiB limit: check for large mail syncs or other programs on the machine                     |

## 12. What was verified

Verified in local containers (the deployment smoke `scripts/deploy-smoke.mjs` also runs in CI): `docker compose config`; `caddy validate` / `caddy fmt` on all three Caddyfiles; `/healthz` and the home page through Caddy; the setup code; access tokens; WebSocket ping/pong; SSE arriving chunk by chunk (a fake model emitting one chunk every 600 ms); the error for a key file with the wrong owner; `secrets migrate` / `rekey`; data volume backup and restore; building the DNSPod Caddy image and `caddy validate` on its Caddyfile.

**Not verified; please check in a real environment:**

1. HTTPS login through a real domain on a real 2C2G machine; real Let's Encrypt issuance and renewal.
2. DNSPod: sub-account permissions and a real DNS-01 issuance (the cloud container cannot reach your DNS account).
3. Memory measurements on the 2C2G machine (app and Caddy resident size), and whether the first build needs swap.
4. Logging in from a phone browser over HTTPS (the `Secure` cookie).
5. This English version is machine-translated and pending proofreading.

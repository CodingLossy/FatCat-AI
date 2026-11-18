---
title: Quick start
description: Run it with Docker in a few minutes, or start from source.
---

## Start with Docker

You need Docker 24 or later with Compose v2. 2 GB or more of memory is suggested; idle use is about 110 MiB with no channels, for reference only.

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs fatcat-ai | grep -i 'setup code'   # the one-time setup code
```

1. **First sign-in.** Open <http://127.0.0.1:8787>, create the owner account (1.0 has exactly one account) and paste the setup code from the log.
2. **Add a model profile.** Settings → Model profiles, see [Configure a model](/FatCat-AI/en/getting-started/models/). Start chatting once it shows "Key: Set".
3. **(Optional) Bind WeChat.** Settings → Channels, add a WeChat channel and scan the QR code. 1.0 includes the WeChat channel only; WeCom is postponed.
4. **Going public.** Do not expose port 8787 directly. Follow the [Docker deployment guide](/FatCat-AI/en/guides/docker/) (Caddy with automatic HTTPS) and turn on two-step verification and secrets encryption first.

:::note
Prebuilt images (GHCR, amd64 / arm64) arrive with the official 1.0 release; until then build from source with `--build` as above.
:::

## Start from source

You need Node.js 24 LTS or later and pnpm 10 (`corepack enable` provides it).

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
export DEEPSEEK_API_KEY='<your key>'   # DeepSeek as an example; a local Ollama needs no key
pnpm dev
```

- Server: <http://127.0.0.1:8787/healthz>; Web UI: <http://127.0.0.1:5173>.
- On Windows PowerShell use `$env:DEEPSEEK_API_KEY = '<your key>'`.
- The default data directory is `~/.fatcat-ai` (`%USERPROFILE%\.fatcat-ai` on Windows); change it with `FATCAT_AI_DATA_DIR`.

## Command-line client

You can set up and chat without the Web UI (after `pnpm build`, run `node apps/cli/dist/bin.js …` from the repository root in place of `fatcat-ai`):

```bash
fatcat-ai setup -u owner
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "Explain AGPL section 13 in three sentences"
fatcat-ai chat
```

## Desktop app

The desktop app arrives in M10; install instructions will be added here once it ships.

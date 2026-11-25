---
title: FAQ
description: The questions that come up most when installing, signing in, handling keys and deploying.
---

## `http://127.0.0.1:8787/` returns 404

When running locally the core server does not serve the Web UI by default: with `pnpm dev`, use port 5173. To serve it from 8787 as well, set `FATCAT_AI_WEB_DIR` to `apps/web/dist` after building. The Docker image is already configured, so use 8787 there.

## Creating the account asks for a setup code

From another machine or through a reverse proxy you must enter the one-time setup code from the startup log (`docker compose … logs fatcat-ai | grep -i 'setup code'`), or pin one with `FATCAT_AI_SETUP_CODE` in `.env`.

## The profile keeps showing "Key: Missing"

An `env:` reference needs the variable to exist in the server **process** (if you set it in a terminal, start the server from that same terminal); a `file:` reference needs a key of that name in `secrets.yaml` in the data directory. For Docker see the [Docker deployment guide](/FatCat-AI/en/guides/docker/).

## Where is my data and how do I back it up?

By default in `~/.fatcat-ai` (`%USERPROFILE%\.fatcat-ai` on Windows, the `/data` volume in Docker). Stop the server before copying (SQLite runs in WAL mode, so a hot copy can be inconsistent) and store the master key separately. Steps are in section 8 of the Docker guide.

## I lost my authenticator and recovery codes

Stop the server first, then run the command below. It resets two-step verification for that one account and your password keeps working. Replace USERNAME with your username; it can be left out when the server has only one account.

- From source: in the repository's `apps/server` directory (after `pnpm build`) run `node dist/index.js auth reset-totp USERNAME`.
- Docker: from the repository's `docker/` directory run `docker compose -f docker-compose.prod.yml stop fatcat-ai`, then `docker compose -f docker-compose.prod.yml run --rm --no-deps -T fatcat-ai node dist/index.js auth reset-totp USERNAME`, then `docker compose -f docker-compose.prod.yml start fatcat-ai`.

## What if I lose the master key?

The encrypted secrets file and the two-factor shared secret can no longer be opened. Keep the master key somewhere off this machine.

## Replies appear all at once instead of streaming

The reverse proxy is buffering responses: Caddy needs `flush_interval -1`, Nginx needs `proxy_buffering off`.

## Why is there no OAuth mail sign-in?

Mail uses IMAP / SMTP with an app password or authorization code, and only a reference to it is stored. For Gmail turn on 2-Step Verification and create an app password; OAuth is not supported.

## Are WeCom and QQ supported?

1.0 includes only the WeChat channel; WeCom is postponed with no date set, and QQ comes later.

## Which license?

AGPL-3.0-only, with a commercial license available (see `COMMERCIAL.md` in the repository). The plugin SDK, client SDK and shared protocol package are Apache-2.0.

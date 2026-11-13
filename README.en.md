# FatCat-AI

[中文](README.md) · Source: <https://github.com/CodingLossy/FatCat-AI> · Issues: <https://github.com/CodingLossy/FatCat-AI/issues>

An AI assistant that is truly your own: self-hostable, open source, bring-your-own-model (BYO LLM), local-first, **telemetry-free**, and pluggable (MCP is a first-class citizen).

> Status: **M4 · voice and images** (pre-release, not yet versioned). On top of M3's mail, tools, local files, knowledge base and long-term memory it adds voice and images: hold to talk and have it transcribed, replies read aloud, a voice status indicator, and images in chat for models that can read them (voice and images go through the OpenAI-compatible endpoint you configure; the key stays on the server). Usable from the Web UI, the command line or curl. See [CHANGELOG.md](CHANGELOG.md) for changes and the development plan (Chinese) at [docs/plan/FatCat-AI-开发计划.md](docs/plan/FatCat-AI-开发计划.md).

## Features (planned)

- **BYO LLM**: any OpenAI-compatible endpoint (including Ollama / LM Studio / vLLM), plus native Anthropic / Gemini support. Confirmed working: DeepSeek (`https://api.deepseek.com/v1`) and OpenRouter (`https://openrouter.ai/api/v1`)
- **Headless core**: every capability is exposed through the versioned `/api/v1` HTTP + WebSocket API; the Web UI, CLI and IM channels are all clients of it
- **Local files, email, voice, scheduled tasks**, with risk-graded tools; dangerous actions require confirmation by default
- **Channels**: WeCom (企业微信) and WeChat in 1.0
- **Knowledge map**: mail, documents, novels, people and more in one item index you can drill into level by level
- **Long-term memory**: typed, superseded rather than overwritten, with sources; answers carry trust labels (reliable, possibly stale, conflicted, inferred); credentials are always refused and sensitive data is redacted before it is stored; you can mark a memory helpful, out of date, wrong or not to be kept, and forget it at any time
- **Lightweight**: runs comfortably on a 2 GB server

## Telemetry-free

FatCat-AI contains **no** analytics or crash-reporting code. It only connects to the model endpoints, mailboxes, channels and plugins you configure, plus an optional (can be disabled) GitHub Releases update check.

## Quick start

Requires Node.js 24 LTS or later and pnpm 10 (`corepack enable` provides it). With M1 you can stream chats from any OpenAI-compatible endpoint (including Ollama, DeepSeek and OpenRouter) and from the native Anthropic and Gemini APIs, resume a reply that is still streaming after a page refresh, have the assistant remember things you tell it (ordinary facts are saved at once and can be undone; sensitive ones or changes to your profile need your approval), and use it from the Web UI, the command line or curl.

### 1. Start

Model keys are only read from environment variables or a local file. The Web UI and the API never accept a plaintext key.

macOS / Linux:

```bash
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
export DEEPSEEK_API_KEY='<your key>'   # DeepSeek as an example; a local Ollama needs no key
pnpm dev
```

Windows (PowerShell):

```powershell
git clone https://github.com/CodingLossy/FatCat-AI.git
cd FatCat-AI
pnpm install
$env:DEEPSEEK_API_KEY = '<your key>'
pnpm dev
```

- Core server: <http://127.0.0.1:8787/healthz>
- Web UI: <http://127.0.0.1:5173>. Create the owner account when asked (1.0 has exactly one account), add a profile under Settings → Model profiles with the key reference `env:DEEPSEEK_API_KEY` (leave it empty for a local Ollama), and start chatting once it shows "Key: Set".
- When you run it locally, the core server doesn't serve the Web UI by default: without `FATCAT_AI_WEB_DIR`, <http://127.0.0.1:8787/> returns 404. That is expected; with `pnpm dev`, use port 5173. To serve the Web UI from port 8787 (for example after `pnpm build`, with `pnpm --filter @fatcat-ai/server start`, which also sets the memory flag `--max-semi-space-size=8`), set `FATCAT_AI_WEB_DIR` to the absolute path of `apps/web/dist` first. The Docker image already sets it.

Instead of an environment variable, you can put keys in `secrets.yaml` in the data directory (`~/.fatcat-ai` by default, `%USERPROFILE%\.fatcat-ai` on Windows), one `NAME: value` per line, and reference them as `file:NAME`. Changes take effect without a restart. When the server writes this file itself (for example a WeChat login token), on Windows it removes inherited access entries and leaves full control only for the current user. If that step fails it logs a warning and keeps the file.

**Encrypting the secrets file** (optional; it needs your explicit confirmation and never happens automatically): use Settings → Secrets → "Encrypt secrets file", or stop the server and run `node dist/index.js secrets migrate`. The server backs up first, encrypts `secrets.yaml` into `secrets.yaml.enc` (AES-256-GCM), decrypts it again and compares every key, and only if all of that passes renames the plaintext file to `secrets.yaml.migrated`; remove that with `node dist/index.js secrets cleanup` once you have checked everything works. The master key comes from, in order: the environment variable `FATCAT_MASTER_KEY` (64 hex characters or base64), the file named by `FATCAT_MASTER_KEY_FILE`, or a `master.key` generated in the data directory (mode 600; current user only on Windows). If the first two are malformed the server refuses to start instead of silently using the next. **Losing the master key means losing every secret** (re-enter model keys, scan WeChat again); the master key is never part of a backup. Anyone who gets the whole data directory, `master.key` included, can still decrypt, so for public deployments keep the master key in an environment variable or a container secret. To rotate it, stop the server and run `node dist/index.js secrets rekey --new-key-file <file>` (a key is never accepted on the command line). On a fresh install with no secrets file, the first secret written (for example a WeChat login token) goes straight into the encrypted file; having both the plaintext and the encrypted file makes the server refuse to start.

**Two-step verification (TOTP, optional)**: turn it on in Settings → Security, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …) and save the 10 one-time recovery codes, which are shown only once. Afterwards signing in needs the password plus a 6-digit code (or a recovery code), and turning it on signs out every other session. Existing personal access tokens keep working, but creating a new one needs a browser session that passed the second factor. The shared secret is stored in the database encrypted with the master key described above; if that key is unavailable, signing in with a code fails rather than being skipped, and recovery codes are stored only as salted hashes. If you lose both the code and the recovery codes, run `node dist/index.js auth reset-totp` on the server machine (it removes the TOTP data and signs every session out); your password keeps working. Anyone who gets the whole data directory can decrypt the shared secret too, so for public deployments keep the master key in an environment variable.

> This project used to be called AI-Personal. After upgrading, the server moves an old `~/.ai-personal` to `~/.fatcat-ai` on its first start (it never overwrites an existing `~/.fatcat-ai`). Old `AIP_*` environment variables still work for now, with a warning to switch to `FATCAT_AI_*`.

### 2. Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

The image also serves the Web UI at <http://127.0.0.1:8787>. Data, including `secrets.yaml`, lives in the `/data` volume. Write a key there like this, then reference `file:DEEPSEEK_API_KEY` in the profile:

```bash
printf 'DEEPSEEK_API_KEY: "%s"\n' '<your key>' | \
  docker compose -f docker/docker-compose.yml exec -T fatcat-ai sh -c 'umask 077; cat > /data/secrets.yaml'
```

> Upgrading from AI-Personal: the compose service was renamed from `ai-personal` to `fatcat-ai`; the `ai-personal-data` volume is unchanged, so your data stays. Before upgrading, run `docker compose -f docker/docker-compose.yml down` with the old compose file, or start the new version with `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans`. Otherwise the old container keeps running and holds port 8787, and the new one can't start.

It only listens on 127.0.0.1 by default; to reach it from other machines, put it behind a reverse proxy with HTTPS. Setting it up from another machine or through a proxy needs the one-time setup code printed in the startup log (`docker compose -f docker/docker-compose.yml logs`).

### 3. A full chat with curl (no Web UI)

Everything is in the versioned `/api/v1` API; the OpenAPI document is at `/api/v1/openapi.json` (authentication required). The example signs up with a password, exchanges the session for a personal access token, and then sends `Authorization: Bearer`, which needs no CSRF token.

```bash
API=http://127.0.0.1:8787/api/v1

# Create the owner (no setup code needed from this machine); the session cookie goes to jar.txt
curl -s -c jar.txt -X POST $API/auth/setup -H 'content-type: application/json' \
  -d '{"username":"owner","password":"correct horse battery staple"}' > setup.json
CSRF=$(sed -E 's/.*"csrfToken":"([^"]+)".*/\1/' setup.json)

# Exchange it for a personal access token (the plaintext is only returned once)
TOKEN=$(curl -s -b jar.txt -X POST $API/tokens -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"curl"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
AUTH="authorization: Bearer $TOKEN"

# Add a model profile; keyStatus "present" means the server found the key
curl -s -X POST $API/models -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"deepseek","kind":"openai-compatible","baseURL":"https://api.deepseek.com/v1","apiKeyRef":"env:DEEPSEEK_API_KEY","model":"deepseek-flash","purpose":["chat","cheap"]}'

# Create a session and send a message; -N streams the reply as server-sent events
SID=$(curl -s -X POST $API/sessions -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -N -X POST $API/sessions/$SID/messages -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"Remember: I live in Hangzhou"}'
```

When the stream shows `approval-required` (for example the model wants to call `memory.save`), the run pauses until you approve or reject it from another terminal:

```bash
curl -s -X POST $API/approvals/<callId> -H "$AUTH" -H 'content-type: application/json' -d '{"decision":"approve"}'
```

After a disconnect you can resume the same run: `curl -N $API/runs/<runId>/events -H "$AUTH" -H 'last-event-id: 0'`.

The same flow in Windows PowerShell (the streaming part uses the built-in `curl.exe`):

```powershell
$api = 'http://127.0.0.1:8787/api/v1'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$setup = Invoke-RestMethod -Method Post "$api/auth/setup" -WebSession $s -ContentType 'application/json' `
    -Body '{"username":"owner","password":"correct horse battery staple"}'
$tok = Invoke-RestMethod -Method Post "$api/tokens" -WebSession $s -Headers @{ 'X-CSRF-Token' = $setup.csrfToken } `
    -ContentType 'application/json' -Body '{"name":"powershell"}'
$h = @{ Authorization = "Bearer $($tok.token)" }
Invoke-RestMethod -Method Post "$api/models" -Headers $h -ContentType 'application/json' -Body (@{
    label = 'deepseek'; kind = 'openai-compatible'; baseURL = 'https://api.deepseek.com/v1'
    apiKeyRef = 'env:DEEPSEEK_API_KEY'; model = 'deepseek-flash'; purpose = @('chat', 'cheap')
} | ConvertTo-Json)
$sid = (Invoke-RestMethod -Method Post "$api/sessions" -Headers $h -ContentType 'application/json' -Body '{}').id
'{"text":"Hello"}' | curl.exe -N -X POST "$api/sessions/$sid/messages" -H "Authorization: Bearer $($tok.token)" `
    -H 'content-type: application/json' --data-binary '@-'
```

### 4. Command-line client

You can also set up and chat without the Web UI (after `pnpm build`, run `node apps/cli/dist/bin.js …` from the repository root in place of `fatcat-ai` in the examples below):

```bash
fatcat-ai setup -u owner          # create the owner and save a personal access token (~/.fatcat-ai/cli.json, mode 0600)
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "Explain AGPL section 13 in three sentences"
fatcat-ai chat                    # interactive chat: /new /model /retry /exit; Ctrl+C stops the current reply
```

For Anthropic or Gemini use `--kind anthropic` or `--kind gemini` (no `--base-url` needed). Tool calls that need approval (such as `memory.save`) are asked about in a terminal and rejected when not interactive, unless you pass `--approve-tools`.

### 5. WeChat

1. Settings → Channels: add a WeChat channel, enable it, click "Log in with QR code", scan with the WeChat account the assistant should use and confirm on the phone.
2. The login token is stored in `secrets.yaml` in the data directory (key `ILINK_TOKEN_<channel id>`). Before writing, the server copies the file to `backups/secrets-<UTC time>.yaml` (mode 600, newest 5 kept) and changes only that line; it doesn't write if `secrets.yaml` doesn't parse. On Windows it then removes inherited access entries so only the current user has full control. Deleting the channel removes only that line.
3. Click "Create pairing code" and send 「绑定 123456」 from your own WeChat to the assistant account. After that only your direct messages reach the chat; approve or deny actions with 「确认 K7」 / 「拒绝 K7」. `/clear` or 「清空」 clears only this channel's current conversation and does not delete memories. In the Web session list you can delete one conversation, or clear all of them (memories are kept there too).
4. When the login expires the channel shows "Needs QR login"; scan again. Images, files and logins that ask for a PIN are not supported yet.

### Development

`pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest), and after `pnpm build`, `pnpm test:e2e` (Playwright smoke test; run `pnpm --filter @fatcat-ai/web exec playwright install chromium` once first). Conventions are in [AGENTS.md](AGENTS.md) and changes in [CHANGELOG.md](CHANGELOG.md).

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## License

FatCat-AI is dual-licensed:

- **Open source**: [GNU AGPL-3.0](LICENSE) (`AGPL-3.0-only`). You may use, modify and distribute it, including commercially, but if you distribute a modified version or **make a modified version available to users over a network**, you must release the complete corresponding source under the AGPL-3.0.
- **Commercial license**: to use, embed or modify FatCat-AI in closed-source products or services without AGPL obligations, see [COMMERCIAL.md](COMMERCIAL.md).

The plugin SDK (`@fatcat-ai/plugin-sdk`) and client SDK (`@fatcat-ai/client`) are released under [Apache-2.0](packages/plugin-sdk/LICENSE).

Contributions require signing the [CLA](CLA.md) (prompted automatically on your PR). The "FatCat-AI" name and logo are trademarks of the author; see [TRADEMARKS.md](TRADEMARKS.md). Commercial licensing: x19169738916@163.com.

Copyright (C) 2026 尹绪柏 (Theodore Yin)

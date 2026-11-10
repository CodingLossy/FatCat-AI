# FatCat-AI

[中文](README.md) · Source: <https://github.com/CodingLossy/FatCat-AI> · Issues: <https://github.com/CodingLossy/FatCat-AI/issues>

An AI assistant that is truly your own: self-hostable, open source, bring-your-own-model (BYO LLM), local-first, **telemetry-free**, and pluggable (MCP is a first-class citizen).

> Status: **M3 · mail** (pre-release, not yet versioned). On top of M2's tools, local files, knowledge base and long-term memory it adds IMAP/SMTP mail: Inbox and Sent are synced, and the assistant can summarize mail, draft replies and send them after you approve. Instructions inside an e-mail can't make it send anything (session-level taint and recipient checks), and you can drill down to a message in the knowledge map and use "Ask AI" on it. Usable from the Web UI, the command line or curl. See [CHANGELOG.md](CHANGELOG.md) for changes and the development plan (Chinese) at [docs/plan/FatCat-AI-开发计划.md](docs/plan/FatCat-AI-开发计划.md).

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

Instead of an environment variable, you can put keys in `secrets.yaml` in the data directory (`~/.fatcat-ai` by default, `%USERPROFILE%\.fatcat-ai` on Windows), one `NAME: value` per line, and reference them as `file:NAME`. Changes take effect without a restart.

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
  -d '{"label":"deepseek","kind":"openai-compatible","baseURL":"https://api.deepseek.com/v1","apiKeyRef":"env:DEEPSEEK_API_KEY","model":"deepseek-chat","purpose":["chat","cheap"]}'

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
    apiKeyRef = 'env:DEEPSEEK_API_KEY'; model = 'deepseek-chat'; purpose = @('chat', 'cheap')
} | ConvertTo-Json)
$sid = (Invoke-RestMethod -Method Post "$api/sessions" -Headers $h -ContentType 'application/json' -Body '{}').id
'{"text":"Hello"}' | curl.exe -N -X POST "$api/sessions/$sid/messages" -H "Authorization: Bearer $($tok.token)" `
    -H 'content-type: application/json' --data-binary '@-'
```

### 4. Command-line client

You can also set up and chat without the Web UI (after `pnpm build`, run `pnpm --filter @fatcat-ai/cli exec fatcat-ai …`, or `node dist/bin.js …` in `apps/cli`):

```bash
fatcat-ai setup -u owner          # create the owner and save a personal access token (~/.fatcat-ai/cli.json, mode 0600)
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 --model deepseek-chat --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "Explain AGPL section 13 in three sentences"
fatcat-ai chat                    # interactive chat: /new /model /retry /exit; Ctrl+C stops the current reply
```

For Anthropic or Gemini use `--kind anthropic` or `--kind gemini` (no `--base-url` needed). Tool calls that need approval (such as `memory.save`) are asked about in a terminal and rejected when not interactive, unless you pass `--approve-tools`.

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

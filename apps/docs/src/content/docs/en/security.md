---
title: Security
description: FatCat-AI's security defaults, the hardening steps you should take, and how to report a vulnerability.
---

## Defaults

- **Listens on `127.0.0.1` only.** To reach it from other machines, put it behind a reverse proxy with HTTPS; see the [Docker deployment guide](/FatCat-AI/en/guides/docker/).
- **Dangerous actions need approval by default.** Tool calls such as writing files, sending mail or saving memory show a summary in the UI (or in WeChat) first and run only after you approve; a standing approval needs your explicit "Always".
- **External content is untrusted.** Web pages, mail, files and sub-agent output are treated as data, not instructions: text saying "ignore your earlier instructions" does not change behavior.
- **Anything sent out needs approval.** Sending mail or a channel message asks you first.
- **No telemetry.** No analytics or crash-reporting code; it only connects to the models, mailboxes, channels and plugins you configure, plus an optional (can be disabled) GitHub Releases update check.
- **Logs stay local** as JSON lines and never leave the machine; API keys are never logged or echoed.

## Before you expose it

1. Create the owner account, then clear `FATCAT_AI_SETUP_CODE` once it has been used.
2. Turn on **two-step verification (TOTP)** under Settings → Security and keep the 10 recovery codes safe.
3. **Encrypt the secrets file** under Settings → Secrets → "Encrypt secrets file". Back up the master key separately; without it the encrypted secrets cannot be opened.
4. Review Settings → Egress targets: it should contain only the model endpoints, mail servers and similar addresses you use.
5. Check that the app container publishes no port; only Caddy should.

## Boundaries

- **File tools** can only access folders you authorized; the server resolves links and short names and stores the real path, and a whole drive cannot be authorized.
- **Multi-agent**: a sub-agent can only use the intersection of its own tool set and its delegator's, so it cannot step outside the allowlist.
- **Plugins** run in a sandbox and get only the permissions they declare and you approve.

## Reporting a vulnerability

Please do **not** report vulnerabilities in public issues. Email x19169738916@163.com with a subject starting with "[FatCat-AI Security]", including affected versions, reproduction steps and impact; or use GitHub [private vulnerability reporting](https://github.com/CodingLossy/FatCat-AI/security/advisories/new). We aim to acknowledge reports within 5 business days. Only the latest minor release receives security fixes.

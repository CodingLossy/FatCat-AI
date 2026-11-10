# Contributing to AI-Personal

Thank you for your interest in contributing! Source code and issues live at <https://github.com/CodingLossy/AI-Personal>.

## 1. Sign the CLA first

AI-Personal is dual-licensed (AGPL-3.0-only + a commercial license). So that the author can include your contribution in the commercial edition as well, **every external contributor must sign the [CLA](CLA.md)**.

- Individuals: CLA Assistant asks you to sign on your first pull request; just reply as instructed.
- Contributing on behalf of a company: have the company sign Part II of CLA.md (the Corporate CLA) and email it to x19169738916@163.com.

Pull requests without a signed CLA cannot be merged. The project does **not** accept a DCO sign-off in place of the CLA.

## 2. Development setup

- Node.js 24 LTS or later and pnpm 10 (`corepack enable`)
- `pnpm install` to install dependencies; `pnpm dev` starts the core server (127.0.0.1:8787) and the Web UI (127.0.0.1:5173)

| Command                                      | Purpose                                  |
| -------------------------------------------- | ---------------------------------------- |
| `pnpm dev`                                   | Run server + web in development mode     |
| `pnpm build`                                 | Build all packages                       |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint / type check / unit tests         |
| `pnpm format`                                | Format with Prettier                     |
| `pnpm check:spdx`                            | Check SPDX headers in source files       |
| `pnpm check:licenses`                        | Check the dependency license allowlist   |
| `pnpm check:placeholders`                    | Check for leftover template placeholders |

## 3. Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) **in English**: `feat(server): ...`, `fix(web): ...`, `docs: ...`, `chore: ...`.
- Keep changes small: one feature per branch / PR. Describe the motivation, the changes and how you tested them; list open design questions under "Open questions".
- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
- Do not add AI attribution such as `Co-Authored-By: <AI tool>` trailers to commits or pull requests.
- The repository history was rewritten on 2026-11-10. Sync to the new `main` (or clone again) before you start, and never push `main`, `docs/m3-wrapup` or `docs/memory-plan-tdam` from an old clone.
- Write an ADR in `docs/adr/` before changing schemas or the event protocol in `packages/shared`.
- New tools need unit tests and at least one eval case; changes touching approvals or permissions need a privilege-escalation test case.

## 4. License headers

Every new source file starts with an SPDX header (the year is the year the file was created):

```ts
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
```

`packages/plugin-sdk`, `packages/client` and `packages/shared` use `Apache-2.0`. YAML / shell / Dockerfile use `#`, CSS uses `/* */`, HTML uses `<!-- -->`. See [templates/FILE-HEADER.txt](templates/FILE-HEADER.txt). External contributors do not add their names to file headers; their copyright is covered by the CLA and recorded in git history.

## 5. Dependency license allowlist

Only permissively licensed dependencies are allowed: MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0, and MPL-2.0 **only when used as an unmodified library**.

Third-party copyleft dependencies (GPL, LGPL, AGPL, SSPL, EUPL, CDDL, …) are **forbidden**, because they would make the commercial edition impossible to distribute. `pnpm check:licenses` enforces this in CI.

Also forbidden: telemetry or crash-reporting SDKs (Sentry, PostHog, Segment, …), dependencies that require an extra always-on service, and code snippets of unknown origin or license. AI-generated code is submitted under the project license; please disclose it in your PR.

## 6. Security issues

Please do not report vulnerabilities in public issues; see [SECURITY.md](SECURITY.md).

Copyright (C) 2026 尹绪柏 (Theodore Yin)

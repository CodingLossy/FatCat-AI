<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 尹绪柏 (Theodore Yin)
-->

# Plugin market scripts

Scripts for the plugin market (design: `docs/adr/0040-plugins-and-market.md`, sections 5 and 11).

| Script                    | Where it runs                    | Needs                                     |
| ------------------------- | -------------------------------- | ----------------------------------------- |
| `sign-index.mjs`          | The owner's own machine only     | Node 24, the private key file             |
| `check-index.mjs`         | CI of the index repository       | A built FatCat-AI checkout (`pnpm build`) |
| `index-repo-workflow.yml` | Copied into the index repository | -                                         |
| `probe-permission.mjs`    | Any platform (PR 2b)             | A built FatCat-AI checkout                |

## The index repository

The official index lives in `CodingLossy/fatcat-plugins`. It holds `index.json` and its signature `index.json.sig`,
published with GitHub Pages (the client downloads `https://codinglossy.github.io/fatcat-plugins/index.json` and
`index.json.sig`; Pages answers directly, without redirects). Plugin authors add or change entries through pull
requests; a maintainer reviews the package and merges.

### One-time setup (owner)

1. In `CodingLossy/fatcat-plugins`, copy `scripts/plugins/index-repo-workflow.yml` from this repository to
   `.github/workflows/check-index.yml`. It has no secrets and read-only permissions. Set `FATCAT_AI_REF` to a commit of
   this repository that you have reviewed instead of `main`.
2. Protect `main` and make the `check index / check` job required. Nobody can then merge an index that fails the checks.
3. Turn on GitHub Pages for the repository (branch `main`, root folder).
4. Start with an empty index and sign it (below). A minimal one:

   ```json
   {
     "formatVersion": 1,
     "market": "official",
     "serial": 1,
     "generatedAt": "2026-11-18T00:00:00Z",
     "expiresAt": "2026-12-18T00:00:00Z",
     "downloadHosts": ["github.com", "objects.githubusercontent.com"],
     "plugins": []
   }
   ```

   Packages are `.tgz` files with `plugin.json` at the root, for example GitHub release assets. Every download host an
   entry uses must be listed in `downloadHosts`.

You can also copy `sign-index.mjs` on its own to the machine that holds the key: it only uses `node:crypto`.

### What the CI checks (`check-index.mjs`)

- `index.json` matches the same `PluginIndex` schema the client uses; ids are unique; every `url` is `https:` on a host in `downloadHosts`.
- Compared with the previous index: no plugin or version is removed (withdraw with `"yanked": true` and a `yankedReason`),
  a published version's `url`, `size`, `sha256`, `engines`, `permissions` and `publishedAt` never change, a withdrawn
  version is never restored, `serial` never goes down and goes up whenever the content changes.
- Every new version is downloaded again: the size and `sha256` must match, the archive must pass the same tar reader as
  the client (no symbolic links, `..`, drive letters, reserved Windows names, case-only duplicates, decompression
  bombs), `plugin.json` must pass the manifest schema, and its `id`, `version` and `permissions` must equal the entry.
- Static check of the packaged code: no mention of the modules the runtime refuses (`net`, `http`, `child_process`, ...),
  `process.binding`, `process.dlopen`, `eval` or `new Function`.

A matching checksum and signature only show that the package is the one that was reviewed. They do not show that the
reviewer approved a harmless package; the human review of every pull request is the control for that.

## Signing (owner, on the owner's machine)

The signing keys are two Ed25519 key pairs, `fatcat-main-2026` and `fatcat-backup-2026`. Both public keys are built into
FatCat-AI, and an index signed with either is accepted. Private keys stay offline (with an offline backup each). They are
never put in CI, GitHub Secrets, an environment variable or this repository; `sign-index.mjs` reads the private key only
from a local PKCS#8 PEM file whose path you give on the command line, and refuses to run when `CI` is set.

At least once a month (the default validity is 30 days; clients ignore an expired index):

1. Pull the merged `main` of the index repository.
2. Raise `serial`, set `generatedAt` to now and `expiresAt` to 30 days later in `index.json`, commit and merge it
   through a pull request like any other change (for example with
   `jq '.serial += 1 | .generatedAt = (now | todate) | .expiresAt = ((now + 2592000) | todate)' index.json > index.next && mv index.next index.json`).
3. Sign the merged file, byte for byte:

   ```
   node scripts/plugins/sign-index.mjs --key /path/to/fatcat-main-2026.pem --key-id fatcat-main-2026 --index index.json
   ```

   This writes `index.json.sig`: `{ "keyId": "...", "alg": "ed25519", "sig": "<base64 of the Ed25519 signature>" }`. The
   script refuses a key that does not match the public key built into the client for that `keyId`, and an index that
   is already expired.

4. Commit `index.json.sig` to `main` (it must be published together with the exact `index.json` that was signed). Do
   not reformat `index.json` afterwards: the signature covers its exact bytes.
5. Check what is published: `node scripts/plugins/sign-index.mjs --verify` (public keys only; the workflow runs it too).

If the main key is lost or leaked, sign with `fatcat-backup-2026` and ship a client release that replaces the leaked
public key in `packages/tools/src/plugins/market.ts` and in `sign-index.mjs`.

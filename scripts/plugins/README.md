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
| `pack-plugin.mjs`         | A plugin author's machine        | Node 24, a built FatCat-AI checkout       |
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
- Static check of the packaged code: no code that loads a module the runtime refuses (`net`, `http`, `child_process`, ...),
  no `process.binding`, `process.dlopen`, `eval` or `new Function`. The scan only recognizes the ways to load a module:
  `import x from 'm'`, `import 'm'`, `export ... from 'm'`, `import('m')`, `require('m')` (and esbuild's `__require('m')`),
  `process.getBuiltinModule('m')` and `createRequire(...)('m')`, with or without the `node:` prefix and with
  `/promises`. A module name inside an ordinary string (for example `'net'` in a list of option names) is not a hit.
  It reads literals only: a name built at run time, a `createRequire` result stored in a variable first, or a loader
  passed around as a value is not seen. The scan is a first filter before the human review; the preload hooks and the
  operating-system isolation in `docs/adr/0040-plugins-and-market.md` section 3.4 are what stop those at run time.

## Packing a plugin (plugin author)

`pack-plugin.mjs` turns a folder into the `.tgz` the market expects. Run `pnpm build` once in a FatCat-AI checkout first
(the script uses the client's own tar reader and manifest check to test its output).

```
node scripts/plugins/pack-plugin.mjs <plugin-folder> [--out hello-0.2.0.tgz] [--url <where you will upload it>] [--core-version 1.1.0]
```

- `plugin.json` must be at the top of the folder. Files are written sorted by path, with a fixed time, owner and mode
  (`0644`), a fixed gzip header and no directory entries, so packing the same folder twice gives the same bytes on
  every platform.
- Only ustar is written. A path longer than 100 bytes goes into the 155-byte prefix field; if it does not fit, the
  script stops and asks for shorter names. It never writes pax or GNU long names.
- It refuses symbolic links, junctions, hard links, special files and any `node_modules` folder.
- The result is unpacked again with the client's `extractTgz` and `validateStagedPackage`, and the code is run through
  the static check above; the file is written only if all of that passes.
- It prints the path, size, sha256 and a draft version entry for `index.json`. Fill in `url` after you upload the file
  (for example as a GitHub release asset), and change `publishedAt` if you publish later.

Packing the `hello` example into one file (the installer never runs `npm install`, so dependencies must be bundled):

```
mkdir -p /tmp/hello-pack
pnpm dlx esbuild@0.28.2 examples/plugins/hello/server.mjs --bundle --platform=node --format=esm --target=node24 --outfile=/tmp/hello-pack/server.mjs
cp examples/plugins/hello/plugin.json /tmp/hello-pack/
node scripts/plugins/pack-plugin.mjs /tmp/hello-pack --out hello-0.2.0.tgz
```

esbuild is not a dependency of this repository; it is only used here as an example bundler (the lockfile already
contains `esbuild@0.28.2` through Vite). Any bundler that produces one JavaScript file works.

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

Argument handling: `sign-index.mjs` reads its arguments first. `--verify` is allowed in CI (`CI` or `GITHUB_ACTIONS` set),
uses only the built-in public keys, and refuses `--key`, `--key-id` and `--allow-unknown-key-id`. Signing is refused in
CI whatever the arguments are. The workflow therefore calls the script directly, and prefixing it with `env -u CI` also
works.

If the main key is lost or leaked, sign with `fatcat-backup-2026` and ship a client release that replaces the leaked
public key in `packages/tools/src/plugins/market.ts` and in `sign-index.mjs`.

## Updating the pinned checks

`index-repo-workflow.yml` checks out FatCat-AI at the full commit SHA in `FATCAT_AI_REF`, so the index repository
always runs the schema, tar reader and rules you reviewed. To update it, read the diff of `scripts/plugins/` and
`packages/shared`/`packages/tools` between the old and the new commit, then replace the SHA in a pull request to the
index repository. Do not use a branch name there. After a FatCat-AI change to these scripts is merged (for example the
static-scan and `--verify` changes), move `FATCAT_AI_REF` in `.github/workflows/check-index.yml` of the index
repository to the new merge commit; until then the index repository keeps running the older checks.

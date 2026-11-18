# Publishing the SDK packages (owner only)

`@fatcat-ai/shared` and `@fatcat-ai/plugin-sdk` are published to npm as `0.1.0` under the Apache-2.0 license. Nothing in
this repository publishes them: the steps below are done by hand, from the owner's machine, with the owner's npm
account. `@fatcat-ai/plugin-sdk` depends on `@fatcat-ai/shared`, so **shared goes first**.

## Before the first publish

1. Create the npm organization `fatcat-ai` (the scope of both packages) with the owner's npm account and turn on
   two-factor authentication for publishing.
2. `npm login` on the machine you publish from.
3. In a clean checkout of `main`: `pnpm install --frozen-lockfile && pnpm build`.

## Check what will be published (no upload)

```
cd packages/shared && pnpm pack --pack-destination /tmp/fatcat-pack
cd ../plugin-sdk && pnpm pack --pack-destination /tmp/fatcat-pack
tar tzf /tmp/fatcat-pack/fatcat-ai-plugin-sdk-0.1.0.tgz
tar xzOf /tmp/fatcat-pack/fatcat-ai-plugin-sdk-0.1.0.tgz package/package.json
```

`pnpm pack` replaces `workspace:*` with the real version. The SDK's `dependencies` must show
`"@fatcat-ai/shared": "0.1.0"` and nothing may still say `workspace:`. The archives contain `dist/`, `LICENSE`,
`README.md` and `package.json` only.

## Publish

```
cd packages/shared
pnpm publish --access public        # asks for the one-time password (OTP)
cd ../plugin-sdk
pnpm publish --access public
```

`publishConfig.access` is already `public`, but pass `--access public` anyway: a scoped package defaults to private.
Publish the SDK only after `npm view @fatcat-ai/shared@0.1.0 version` answers. A published version cannot be changed or
reused; fix mistakes with a new version.

## After publishing

Check `npm view @fatcat-ai/plugin-sdk dependencies`, then in an empty folder `npm install @fatcat-ai/plugin-sdk` and
import it from a `.mjs` file. Tag the release only if the owner asks for one.

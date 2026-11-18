# hello: a minimal FatCat-AI plugin

The smallest useful plugin: a `plugin.json` manifest plus a JavaScript entry that speaks MCP over stdio.

- `plugin.json` declares the plugin (see ADR 0040, section 2). Anything not listed under `permissions` is denied.
- `server.mjs` registers two read-only tools with `@fatcat-ai/plugin-sdk`. It reads its settings from `ctx.settings`
  (declared under `settings` in `plugin.json` and filled in on the Plugins page), fetches a page through the server with
  `ctx.fetch` (only `example.com` is granted under `permissions.net`), and offers a few notes to the knowledge map with
  `registerItemProvider`.
- `taskTemplates` in `plugin.json` offers a task draft you can create from the Plugins page and confirm on the Tasks page.

Because it is a plain MCP server, any MCP client can talk to it:

```sh
node examples/plugins/hello/server.mjs
```

## Shipping a plugin

A plugin is installed from one self-contained folder and the installer never runs `npm install`. Bundle your entry and its
dependencies into a single `.js` / `.mjs` file (any bundler works), keep `plugin.json` at the package root, and make
`entry.main` point at the bundle. This example skips bundling and imports the SDK from the workspace, so it only runs
inside this repository.

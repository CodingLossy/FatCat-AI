# Developing FatCat-AI plugins

_Chinese version: [developing-plugins.zh-CN.md](developing-plugins.zh-CN.md). The English text was written for the
first release and is waiting for a native-speaker review._

A plugin is a folder (or a `.tgz` published through the market) with a `plugin.json` manifest and a JavaScript entry
that speaks MCP over stdio. The server starts it as a separate process, asks it for its tools, and registers the
tools it declared as `plugin.<id>.<tool>`. Every call still goes through the normal approval flow. The design is in
[ADR 0040](../adr/0040-plugins-and-market.md); this page is the practical part.

## 1. The smallest plugin

```
my-plugin/
  plugin.json
  server.mjs      # one file: bundle your dependencies into it
```

```json
{
  "manifestVersion": 1,
  "id": "hello",
  "version": "0.1.0",
  "name": { "en": "Hello" },
  "description": { "en": "Greets people" },
  "author": "You",
  "license": "Apache-2.0",
  "engines": { "fatcat": ">=1.1.0" },
  "entry": { "type": "mcp-stdio", "main": "server.mjs" },
  "permissions": { "tools": [{ "name": "hello", "risk": "read" }] }
}
```

```js
import { definePlugin } from '@fatcat-ai/plugin-sdk';

const plugin = definePlugin({ name: 'hello', version: '0.1.0' });
plugin.registerTool({
  name: 'hello',
  description: 'Greet someone by name.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: (args) => `Hello, ${String(args.name)}!`,
});
await plugin.run();
```

A complete example with settings, brokered network requests, knowledge-map items and a task template is in
[`examples/plugins/hello`](../../examples/plugins/hello). You can also wrap an existing MCP server written in
JavaScript: bundle it into a single `.mjs` file, list its tool names under `permissions.tools`, and point
`entry.main` at it. The server never needs the SDK for that, because the protocol is plain MCP.

## 2. Permissions are declared, not requested

The manifest's `permissions` is the whole contract. The user sees all of it before installing, and nothing outside it
works:

| Field                | Meaning                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools[]`            | Tool names and a level: `read`, `write` or `external`. `dangerous` is not allowed. `sendsData: true` marks a tool that sends the user's data out. |
| `net[]`              | Domains the plugin may reach through the server (`ctx.fetch`). Broad patterns such as `*.com` are rejected.                                       |
| `secrets[]`          | Secret names (UPPER_SNAKE_CASE, not starting with `FATCAT_AI_`). The user binds each to an `env:NAME` reference; the value is never stored.       |
| `items.categories[]` | Knowledge-map item categories the plugin provides.                                                                                                |

Tools the plugin offers but did not declare are not registered. A tool with `sendsData` or a `net` permission is treated
as at least `external` and cannot be pre-authorized.

## 3. What the SDK gives you

- `registerTool({ name, description, inputSchema, handler })`: `handler(args, ctx)` returns a string or a `ToolResult`, and may be async.
- `ctx.fetch(url)`: an HTTPS request made by the server on your behalf, only to domains in `permissions.net`, with the
  server's address checks (no private addresses, redirects re-checked, size and time limits). The plugin process
  itself has no direct network access where the platform can enforce it, so use `ctx.fetch`, not the global `fetch`.
- `ctx.settings`: values for the `settings` declared in the manifest (a small JSON Schema subset: string, number,
  boolean). The server renders the form and restarts the plugin when they change.
- `ctx.secret(name)`: a secret the user bound to the plugin.
- `ctx.log(...)`: goes to the server log, with secret values redacted.
- `registerItemProvider({ type, roots, children, open })` and `ctx.items.upsert(...)`: add items to the knowledge map.
- A heartbeat with the process memory is sent every 30 seconds.

## 4. What the sandbox does and does not do

The server starts the plugin with Node's permission model and a preload script. It cannot read the server's data
directory, other plugins' data, or the master key; it does not inherit the server's environment; the built-in modules
for child processes, workers, raw sockets and the like are blocked. **How much of this is enforced depends on the
platform**, and the install page shows the real level for the platform it runs on (enforced, layered, self-reported,
or none). In particular, direct network access is blocked by the operating system only where isolation is available;
on platforms without it, a plugin from a local folder cannot declare `net` at all, and only plugins from the reviewed
market can. Do not rely on the sandbox for things the install page does not list as enforced.

Your plugin's own data goes in the directory the server provides (`ctx.dataDir`, i.e. `plugin-data/<id>/`); it is not
part of the server's automatic backups, but the server copies it once before an upgrade.

## 5. Installing and testing locally

1. In the web UI open **Plugins**, enter the absolute path of your folder, press **Check**, read the permissions and
   protection table, tick the agreement box and install. Checking only copies and inspects the package; it never runs
   your code.
2. Bind any secrets (`env:NAME`), save settings, and enable the plugin.
3. Ask the assistant to use the tool. The call asks for approval unless the user pre-authorized it.

Local installs are shown as unreviewed and unsigned.

## 6. Versions, upgrades and rollback

Use semantic versions. When you install a higher version of an installed plugin, the dialog shows what changed in the
permissions. New tools, raised levels, new `sendsData`, new domains, secrets and categories need the user's approval.
The server backs up `plugin-data/<id>/`, starts the new version, and checks that the handshake and `tools/list` work
and that **every tool you declared is present**. If not, the old version and its data are put back. The user can roll
back to the previous version from the plugin's page. Keep your plugin's data format backward compatible for one
version so a rollback keeps working.

`engines.fatcat` is the range of server versions you support (`>=1.1.0` or `>=1.1.0 <2.0.0`). If the server is later
upgraded outside the range, the plugin is marked incompatible and not started until you publish a compatible version.

## 7. Publishing to the market

The official market is a signed `index.json` in a public repository. A package is a `.tgz` with `plugin.json` at its
root (no symbolic links, hard links, `..`, drive letters or Windows reserved names; limits on size and file count).
The index lists each version with its download URL, size, sha256, permissions and `engines`; the client verifies the
signature, the checksum, and that the package's `plugin.json` matches the index entry. The maintainers' CI checks
and review come first, then the index is signed offline. See [`scripts/plugins/README.md`](../../scripts/plugins/README.md)
for the index tooling. A signature and checksum only show that the package is the one that was reviewed; they do not
promise it is harmless.

## 8. Licensing

Plugins use the license their author chooses. The SDK (`@fatcat-ai/plugin-sdk`) is Apache-2.0. In this release only
free plugins are supported (`licensing.model` is `free`).

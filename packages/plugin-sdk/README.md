# @fatcat-ai/plugin-sdk

SDK for writing FatCat-AI plugins (Apache-2.0). A plugin is a package with a `plugin.json` manifest (schema: `@fatcat-ai/shared`, see ADR 0040) and a JavaScript entry that speaks MCP over stdio. The SDK ships a minimal stdio MCP server, so no other MCP library is needed.

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

- `registerTool` / `registerItemProvider` register what the manifest's `permissions` declares; anything not declared there is not registered by the host.
- `ctx.fetch` sends the request through the host (`fatcat/net.fetch`), which checks the domain against `permissions.net` and the SSRF rules.
- `ctx.log` writes to the host log; `ctx.secret(name)` reads a secret the user bound to the plugin; `ctx.items.upsert` adds knowledge-map items.
- `ctx.caller` (tool calls only, FatCat-AI 2.0 and later): an opaque per-plugin tag for whose conversation is calling, since an admin can open a plugin to other members. It is not the account id and differs between plugins. Keep each caller's data apart and do not cache one caller's results for another; it is `undefined` with older hosts.
- A heartbeat with the process RSS is sent every 30 seconds.

Install: `npm install @fatcat-ai/plugin-sdk` (it depends on `@fatcat-ai/shared`). Bundle the SDK into your entry file before you ship the plugin: the host never runs `npm install`. A complete example is in `examples/plugins/hello`.

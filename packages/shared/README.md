# @fatcat-ai/shared

Protocol schemas and types for [FatCat-AI](https://github.com/CodingLossy/FatCat-AI) (Apache-2.0): the zod schemas and TypeScript types behind the `/api/v1` HTTP + WebSocket API, the event protocol, and the plugin manifest and market index formats (ADR 0040).

```ts
import { PluginManifest } from '@fatcat-ai/shared';

const result = PluginManifest.safeParse(JSON.parse(text));
```

- ESM only; requires Node 24 or later. The only runtime dependency is `zod`.
- Part of the plugin toolchain: `@fatcat-ai/plugin-sdk` depends on it, and the index checks in the plugin index repository use the same schemas as the FatCat-AI client.
- The API is versioned with the server: `/api/v1` and WebSocket protocol v1 only change in backward-compatible ways.

Source and issues: <https://github.com/CodingLossy/FatCat-AI/tree/main/packages/shared>.

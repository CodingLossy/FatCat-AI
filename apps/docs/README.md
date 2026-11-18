# apps/docs

Astro Starlight 文档站(中文为根,英文在 `/en/`),ADR 0043。

Astro Starlight documentation site (Chinese at the root, English under `/en/`).

- `pnpm --filter @fatcat-ai/docs dev`: local preview with search disabled until built; `build` then `node scripts/check-site.mjs` checks links, zh/en parity and the search index.
- Pages live in `src/content/docs/` (Chinese) and `src/content/docs/en/`. Every page needs both languages.
- `docs/deploy/docker*.md` are copied in by `scripts/sync-docs.mjs` at build time (single source, the copies are git-ignored); edit them in `docs/`.
- Published to GitHub Pages by `.github/workflows/docs.yml` after a merge to `main`.

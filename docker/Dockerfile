# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 尹绪柏 (Theodore Yin)
#
# 多阶段构建:build 阶段安装依赖并构建全部包,runtime 阶段只含 server 生产依赖与 Web UI 静态文件,以非 root 用户运行。
# 构建:docker build -f docker/Dockerfile -t ai-personal .

ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# 只重新安装 server 及其工作区依赖的生产依赖(pnpm deploy --legacy 在这里会跳过安装,产出空的 node_modules)
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --filter "@ai-personal/server..."

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_URL=""
ARG VERSION="0.0.0"
LABEL org.opencontainers.image.title="AI-Personal" \
      org.opencontainers.image.description="Self-hostable personal AI assistant framework" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.authors="尹绪柏 (Theodore Yin) <x19169738916@163.com>" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}"
# --max-semi-space-size=8:新生代上限 8 MiB。默认值随堆上限变大,大批量写入(如万封邮件同步)后新生代涨到约 128 MiB,
# 空闲时也不归还。与 SQLite 页缓存降到 4 MiB 合计,万封同步后的常驻内存从约 265 MiB 降到约 141–145 MiB(ADR 0018 第 4 节)。scripts/perf/mail-sync-rss.mjs 读取这一行。
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=384 --max-semi-space-size=8" \
    AIP_HOST=0.0.0.0 \
    AIP_PORT=8787 \
    AIP_WEB_DIR=/app/apps/web/dist \
    AIP_SOURCE_URL=${SOURCE_URL} \
    AIP_DATA_DIR=/data
WORKDIR /app
# 代码与依赖归 root 所有,运行用户 node 只读;只有 /data 可写
COPY --from=build /repo/LICENSE /repo/NOTICE /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /repo/packages/storage/package.json ./packages/storage/
COPY --from=build /repo/packages/storage/dist ./packages/storage/dist
COPY --from=build /repo/packages/storage/node_modules ./packages/storage/node_modules
COPY --from=build /repo/packages/agent/package.json ./packages/agent/
COPY --from=build /repo/packages/agent/dist ./packages/agent/dist
COPY --from=build /repo/packages/agent/node_modules ./packages/agent/node_modules
COPY --from=build /repo/packages/memory/package.json ./packages/memory/
COPY --from=build /repo/packages/memory/dist ./packages/memory/dist
COPY --from=build /repo/packages/memory/node_modules ./packages/memory/node_modules
COPY --from=build /repo/packages/items/package.json ./packages/items/
COPY --from=build /repo/packages/items/dist ./packages/items/dist
COPY --from=build /repo/packages/items/node_modules ./packages/items/node_modules
COPY --from=build /repo/packages/tools/package.json ./packages/tools/
COPY --from=build /repo/packages/tools/dist ./packages/tools/dist
COPY --from=build /repo/packages/tools/node_modules ./packages/tools/node_modules
COPY --from=build /repo/packages/mail/package.json ./packages/mail/
COPY --from=build /repo/packages/mail/dist ./packages/mail/dist
COPY --from=build /repo/packages/mail/node_modules ./packages/mail/node_modules
COPY --from=build /repo/packages/providers/package.json ./packages/providers/
COPY --from=build /repo/packages/providers/dist ./packages/providers/dist
COPY --from=build /repo/packages/providers/node_modules ./packages/providers/node_modules
COPY --from=build /repo/apps/server/package.json ./apps/server/
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /repo/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
WORKDIR /app/apps/server
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

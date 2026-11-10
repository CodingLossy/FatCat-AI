// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.AIP_DEV_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        proxy: {
            // ws: true 让开发时的 /api/v1/ws(审批面板的实时事件)也经过代理
            '/api': { target: SERVER, ws: true },
            '/healthz': SERVER,
        },
    },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

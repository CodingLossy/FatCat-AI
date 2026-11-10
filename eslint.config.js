// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**']),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
        extends: [reactHooks.configs.flat.recommended],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },
]);

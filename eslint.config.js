// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/.astro/**', '**/node_modules/**']),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        // ADR 0046 第 7 节:可视化面板只渲染文本节点
        files: ['apps/web/src/visualizers/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
                    message: 'Visualizers render text nodes only (ADR 0046 section 7).',
                },
                {
                    selector: "Property[key.name='dangerouslySetInnerHTML']",
                    message: 'Visualizers render text nodes only (ADR 0046 section 7).',
                },
            ],
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

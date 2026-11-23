// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

// 中文为根语言(/),英文在 /en/。搜索用 Starlight 内置的 Pagefind(构建时生成静态索引)。
// 部署到 GitHub Pages 的项目页:https://codinglossy.github.io/FatCat-AI/(ADR 0043 第 5 节)。
export default defineConfig({
    site: 'https://codinglossy.github.io',
    base: '/FatCat-AI',
    // 不使用 sharp(它的 libvips 是 LGPL,违反依赖许可白名单):站点没有需要处理的图片,原样输出
    image: { service: passthroughImageService() },
    integrations: [
        starlight({
            title: { 'zh-CN': 'FatCat-AI 文档', en: 'FatCat-AI Docs' },
            description: 'Self-hosted, open source, bring-your-own-model personal AI assistant.',
            defaultLocale: 'root',
            locales: {
                root: { label: '简体中文', lang: 'zh-CN' },
                en: { label: 'English', lang: 'en' },
            },
            social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/CodingLossy/FatCat-AI' }],
            editLink: { baseUrl: 'https://github.com/CodingLossy/FatCat-AI/edit/main/apps/docs/' },
            sidebar: [
                {
                    label: '开始使用',
                    translations: { en: 'Getting started' },
                    items: [{ slug: 'getting-started/quick-start' }, { slug: 'getting-started/models' }],
                },
                {
                    label: '指南',
                    translations: { en: 'Guides' },
                    items: [
                        { slug: 'guides/docker' },
                        { slug: 'guides/desktop' },
                        { slug: 'guides/channels' },
                        { slug: 'guides/plugins' },
                        { slug: 'guides/tool-groups' },
                        { slug: 'security' },
                    ],
                },
                {
                    label: '参考',
                    translations: { en: 'Reference' },
                    items: [{ slug: 'reference/api' }, { slug: 'reference/adr' }, { slug: 'changelog' }],
                },
                { slug: 'faq' },
            ],
        }),
    ],
});

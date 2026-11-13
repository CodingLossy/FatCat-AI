// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 只给内存压测用的预加载脚本(node --import):把发往 iLink 默认地址的请求改到本地假端点,
// 这样被测的是未改动的服务器代码,不需要为测试在产品里开后门。FATCAT_AI_PERF_ILINK_URL 没设置时什么也不做。
const target = process.env.FATCAT_AI_PERF_ILINK_URL;
if (target) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.hostname === 'ilinkai.weixin.qq.com') {
            return realFetch(new URL(url.pathname + url.search, target), init);
        }
        return realFetch(input, init);
    };
}

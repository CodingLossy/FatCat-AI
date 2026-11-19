// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createClient } from '@fatcat-ai/client';
import { DeviceAuth, localDeviceStore } from './device-auth.js';

/** 浏览器里的实例:换令牌用一个不带凭据的 SDK 客户端(公开端点)。 */
export const unauthenticatedApi = createClient({ baseUrl: window.location.origin });
export const deviceAuth = new DeviceAuth({
    store: localDeviceStore(),
    exchange: (refreshToken) => unauthenticatedApi.devices.refresh({ refreshToken }),
});

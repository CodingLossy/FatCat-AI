// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_VERSION: string = pkg.version;

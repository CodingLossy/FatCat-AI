#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { processCtx } from './io.js';
import { main } from './main.js';

const code = await main(process.argv.slice(2), processCtx());
process.exitCode = code;

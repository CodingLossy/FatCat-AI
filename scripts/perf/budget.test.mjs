// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行:node --test scripts/perf/budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capFromMeasured, evaluateChannel } from './budget.mjs';

test('cap is measured x 1.5 rounded up to 5 MiB, at least 5', () => {
    assert.equal(capFromMeasured(0), 5);
    assert.equal(capFromMeasured(3), 5);
    assert.equal(capFromMeasured(3.4), 10);
    assert.equal(capFromMeasured(10), 15);
    assert.equal(capFromMeasured(-2), 5);
});

test('passes when the increment is within the cap and memory settles', () => {
    const r = evaluateChannel({
        idleWithout: 110,
        idleWith: 114,
        settled: [130, 131, 131.5],
        incrementCap: 10,
    });
    assert.equal(r.increment, 4);
    assert.deepEqual(r.errors, []);
});

test('fails on a cap breach, on missing rollback and on creep between run 2 and 3', () => {
    const over = evaluateChannel({ idleWithout: 110, idleWith: 125, settled: [], incrementCap: 10 });
    assert.match(over.errors[0], /rule 5/);
    const noRollback = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [180], incrementCap: 10 });
    assert.match(noRollback.errors[0], /rule 3/);
    const creep = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [130, 131, 137], incrementCap: 10 });
    assert.equal(creep.errors.length, 1);
    assert.match(creep.errors[0], /rule 4/);
});

test('rule 4 compares the last two runs, so an early one-off step does not fail it', () => {
    const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [120, 122, 129, 129.4], incrementCap: 10 });
    assert.deepEqual(r.errors, []);
});

test('rule 4 is skipped with fewer than three runs', () => {
    const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [130, 150], incrementCap: 10 });
    assert.deepEqual(r.errors, []);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行:node --test scripts/perf/budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capFromMeasured, evaluateChannel, evaluateCreep } from './budget.mjs';

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

test('rule 4 does not fail an early one-off step that then stays flat', () => {
    const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [120, 122, 129, 129.4], incrementCap: 10 });
    assert.deepEqual(r.errors, []);
});

test('rule 4 is skipped with fewer than three runs', () => {
    const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [130, 150], incrementCap: 10 });
    assert.deepEqual(r.errors, []);
});

test('rule 4 compares against the highest earlier run, so a one-off GC dip does not fail it', () => {
    for (const settled of [
        [126, 130.1, 119.5, 130.5],
        [127.6, 133.2, 123.1, 135.3],
    ]) {
        const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled, incrementCap: 10 });
        assert.deepEqual(r.errors, []);
    }
});

test('rule 4 still fails when every run is higher than the last', () => {
    const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled: [120, 126, 132, 138], incrementCap: 10 });
    assert.equal(r.errors.length, 2); // 单次 6 MiB 超限,累计检查也触发
    assert.match(r.errors[0], /rule 4/);
});

test('rule 4 fails a slow leak that grows 4 MiB every run, which no single comparison catches', () => {
    for (const settled of [
        [120, 124, 128, 132],
        [120, 124, 128, 132, 136],
    ]) {
        const r = evaluateChannel({ idleWithout: 110, idleWith: 112, settled, incrementCap: 10 });
        assert.equal(r.errors.length, 1);
        assert.match(r.errors[0], /rule 4/);
        assert.match(r.errors[0], /every run since run 2/);
    }
    assert.equal(evaluateCreep([120, 124, 128, 132]).length, 1);
});

test('rule 4 cumulative check ignores a one-off step followed by a flat tail', () => {
    assert.deepEqual(evaluateCreep([120, 124, 126, 126.4]), []);
    assert.deepEqual(evaluateCreep([121.4, 122.9, 127.6, 128.3]), []);
});

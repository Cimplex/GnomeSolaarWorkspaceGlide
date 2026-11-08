import test from 'node:test';
import assert from 'node:assert/strict';
import {acceleratedOffset, recentVelocity, settleDuration, settleTarget} from '../extension/motion.js';

test('acceleration off preserves linear sensitivity', () => {
    assert.equal(acceleratedOffset(100, 1000, 3, 0), 0.3);
});

test('small movement stays precise while larger movement gains more distance', () => {
    const small = acceleratedOffset(10, 1000, 1, 1);
    const large = acceleratedOffset(300, 1000, 1, 1);
    assert.ok(small > 0.01 && small < 0.0102);
    assert.equal(large, 0.39);
    assert.ok(large / 0.3 > small / 0.01);
});

test('curve is symmetric, monotonic and returns exactly to origin', () => {
    let previous = 0;
    for (let distance = 1; distance <= 1000; distance++) {
        const progress = acceleratedOffset(distance, 1000, 3, 1);
        assert.ok(progress > previous);
        assert.equal(acceleratedOffset(-distance, 1000, 3, 1), -progress);
        previous = progress;
    }
    assert.equal(acceleratedOffset(0, 1000, 3, 1), 0);
});

test('curve depends on displacement rather than event rate or path length', () => {
    const original = acceleratedOffset(100, 1000, 3, 1);
    acceleratedOffset(400, 1000, 3, 1);
    assert.equal(acceleratedOffset(100, 1000, 3, 1), original);
});

test('invalid curve parameters are rejected', () => {
    for (const args of [[NaN, 1000], [1, 0], [1, 1000, 0], [1, 1000, 1, -1], [1, 1000, 1, Infinity]])
        assert.throws(() => acceleratedOffset(...args), /Invalid/);
});

test('settling switches once the partial step reaches the threshold', () => {
    assert.equal(settleTarget(1, 1.49), 1);
    assert.equal(settleTarget(1, 1.5), 2);
    assert.equal(settleTarget(1, 0.6), 1);
    assert.equal(settleTarget(1, 0.4), 0);
    assert.equal(settleTarget(1, 1.25, {threshold: 0.25}), 2);
    assert.equal(settleTarget(1, 1.7, {threshold: 0.75}), 1);
});

test('whole steps passed always count and only the last one uses the threshold', () => {
    assert.equal(settleTarget(2, 0.3), 0);
    assert.equal(settleTarget(2, 0.7), 1);
    assert.equal(settleTarget(2, 0.7, {threshold: 0.2}), 0);
});

test('a flick takes any partial step but not a standstill', () => {
    assert.equal(settleTarget(1, 1.05, {flick: true}), 2);
    assert.equal(settleTarget(1, 0.9, {flick: true}), 0);
    assert.equal(settleTarget(1, 1, {flick: true}), 1);
    assert.equal(settleTarget(1, 2, {flick: true}), 2);
});

test('settle rejects invalid input', () => {
    for (const args of [[NaN, 1], [1, Infinity], [1, 1.5, {threshold: 0}], [1, 1.5, {threshold: 1}]])
        assert.throws(() => settleTarget(...args), /Invalid/);
});

test('a flick taking over an unfinished settle goes one step further in its direction', () => {
    // Settling from 1 to 2 was at 1.7 when the next flick began; its base is 2.
    assert.equal(settleTarget(2, 1.85, {flick: true, direction: 1}), 3, 'flicking on again');
    assert.equal(settleTarget(2, 1.6, {flick: true, direction: -1}), 1, 'flicking back');
    assert.equal(settleTarget(2, 1.85, {direction: 1}), 2, 'no flick: nearest');
});

test('a flick that already passed whole steps keeps them', () => {
    assert.equal(settleTarget(2, 0.3, {flick: true}), 0);
});

test('settle duration matches GNOME touchpad swipes', () => {
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual}`);
    assert.equal(settleDuration(1, 1), 0, 'already there');
    assert.equal(settleDuration(1.5, 2, 0), 400, 'released still: base speed, capped at 400 ms for one step');
    near(settleDuration(1.9, 2, 0), 150, '0.1 left at base speed');
    near(settleDuration(1.5, 2, 0.01), 150, 'fast release settles quickly');
    assert.equal(settleDuration(1.5, 2, 1), 100, 'never shorter than 100 ms');
    assert.equal(settleDuration(1.5, 2, -0.01), 400, 'moving away uses base speed');
    assert.equal(settleDuration(1.6, 1, 0), 400);
    assert.ok(settleDuration(0, 2, 0) > 400, 'two steps may take longer');
});

test('recent velocity reads the last 50 ms and treats a pause as stopped', () => {
    const samples = [{time: 0, progress: 0}, {time: 16, progress: 0.1}, {time: 32, progress: 0.2}, {time: 48, progress: 0.3}];
    assert.ok(Math.abs(recentVelocity(samples, 50) - 0.3 / 50) < 1e-9);
    assert.equal(recentVelocity(samples, 300), 0);
    assert.equal(recentVelocity([], 10), 0);
});

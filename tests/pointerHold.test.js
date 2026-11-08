import test from 'node:test';
import assert from 'node:assert/strict';
import {PointerHold, enclosure} from '../extension/pointerHold.js';

function fixture({failAt = -1} = {}) {
    const barriers = [];
    const timers = new Map();
    const cancelled = [];
    let serial = 0;
    const hold = new PointerHold({
        createBarrier(boundary) {
            if (barriers.length === failAt)
                throw new Error('barrier setup failed');
            const barrier = {boundary, destroyed: 0, destroy() { this.destroyed++; }};
            barriers.push(barrier);
            return barrier;
        },
        schedule(milliseconds, callback) {
            const id = ++serial;
            timers.set(id, {milliseconds, callback});
            return id;
        },
        cancelTimer(id) { cancelled.push(id); timers.delete(id); },
    });
    return {hold, barriers, timers, cancelled};
}

test('four boundaries enclose a one-pixel region with inward passage directions', () => {
    assert.deepEqual(enclosure(100.4, 200.8), [
        {x1: 100, y1: 200, x2: 100, y2: 201, direction: 'POSITIVE_X'},
        {x1: 101, y1: 200, x2: 101, y2: 201, direction: 'NEGATIVE_X'},
        {x1: 100, y1: 200, x2: 101, y2: 200, direction: 'POSITIVE_Y'},
        {x1: 100, y1: 201, x2: 101, y2: 201, direction: 'NEGATIVE_Y'},
    ]);
});

test('coordinates stay inside native barrier limits, including screen edges', () => {
    for (const [x, y] of [[0, 0], [-1, -1], [32767, 32767]]) {
        for (const boundary of enclosure(x, y)) {
            for (const key of ['x1', 'x2', 'y1', 'y2'])
                assert.ok(boundary[key] >= 0 && boundary[key] <= 32767);
            assert.ok(boundary.x1 !== boundary.x2 || boundary.y1 !== boundary.y2);
        }
    }
    assert.throws(() => enclosure(NaN, 0), /Invalid/);
});

test('release keeps barriers alive for the requested 350 ms, then destroys all four', () => {
    const {hold, barriers, timers, cancelled} = fixture();
    assert.equal(barriers.length, 0);
    assert.equal(timers.size, 0);
    hold.afterRelease(100, 200, 350);
    assert.deepEqual(cancelled, []);
    assert.equal(timers.get(1).milliseconds, 350);
    assert.ok(barriers.every(barrier => barrier.destroyed === 0));
    timers.get(1).callback();
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
    hold.clear();
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
});

test('turning release delay off removes the hold immediately', () => {
    const {hold, barriers, timers} = fixture();
    hold.afterRelease(100, 200, 0);
    assert.equal(barriers.length, 0, 'Off must never create barriers');
    assert.equal(timers.size, 0);
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
});

test('new gestures clear old barriers and ignore a stale timeout callback', () => {
    const {hold, barriers, timers} = fixture();
    hold.afterRelease(100, 200, 350);
    const oldCallback = timers.get(1).callback;
    hold.clear(); // Starting a new gesture clears the previous release hold.
    hold.afterRelease(200, 300, 350);
    assert.ok(barriers.slice(0, 4).every(barrier => barrier.destroyed === 1));
    oldCallback();
    assert.ok(barriers.slice(4).every(barrier => barrier.destroyed === 0));
    hold.clear();
});

test('cancellation or disable clears timers and all pointer barriers', () => {
    const {hold, barriers, timers} = fixture();
    hold.afterRelease(100, 200, 350);
    hold.clear();
    assert.equal(timers.size, 0);
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
});

test('partial setup failure destroys already-created barriers', () => {
    const {hold, barriers, timers} = fixture({failAt: 2});
    assert.throws(() => hold.afterRelease(100, 200, 350), /setup failed/);
    assert.equal(timers.size, 0);
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
});

test('release timeout removes the enclosure without needing another gesture', () => {
    const {hold, barriers, timers} = fixture();
    hold.afterRelease(100, 200, 350);
    timers.get(1).callback();
    assert.ok(barriers.every(barrier => barrier.destroyed === 1));
    hold.afterRelease(100, 200, 0);
    assert.equal(hold._barriers.length, 0);
});

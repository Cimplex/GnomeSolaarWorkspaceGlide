import test from 'node:test';
import assert from 'node:assert/strict';
import {GestureTracker, buttonId, classify} from '../extension/gesture.js';

function fixture({accept = true, acceptBegin = true, acceptUpdate = true, accepts} = {}) {
    const calls = [];
    let flushes = 0;
    const tracker = new GestureTracker({
        begin: kind => {
            calls.push(['begin', kind]);
            return acceptBegin;
        },
        update: (x, y) => {
            calls.push(['update', x, y]);
            return acceptUpdate;
        },
        end: commit => calls.push(['end', commit]),
        accepts: accepts ?? (() => accept),
        requestFlush: () => flushes++,
    });
    return {tracker, calls, flushes: () => flushes};
}

test('button ids combine unit id and decimal control id', () => {
    assert.equal(buttonId('12D5FD67', 0x1a0), '12D5FD67:416');
    assert.equal(buttonId('12D5FD67', '416'), '12D5FD67:416');
});

test('direction locks only after the threshold and a dominant axis', () => {
    assert.equal(classify(5, 0, 8), null);
    assert.equal(classify(8, 1, 8), 'horizontal');
    assert.equal(classify(-1, -9, 8), 'overview');
    assert.equal(classify(10, 10, 8), null);
    assert.equal(classify(10, 12.5, 8), 'overview');
});

test('a horizontal hold begins once, updates per flush, and commits on release', () => {
    const {tracker, calls, flushes} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 3, 0);
    tracker.moved('A', 3, 0);
    assert.deepEqual(calls, []);
    tracker.moved('A', 3, 1);
    assert.deepEqual(calls, [['begin', 'horizontal']]);
    tracker.moved('A', 10, 0);
    assert.equal(flushes(), 1, 'one flush request per frame, however many moves');
    tracker.flush();
    tracker.flush();
    assert.deepEqual(calls.slice(1), [['update', 19, 1]]);
    tracker.moved('A', -40, 0);
    tracker.ended('A', false);
    assert.deepEqual(calls.slice(2), [['update', -21, 1], ['end', true]]);
    assert.equal(tracker.state, 'idle');
});

test('the locked direction does not change mid-hold', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 0, -20);
    tracker.moved('A', 200, 0);
    tracker.flush();
    assert.deepEqual(calls, [['begin', 'overview'], ['update', 200, -20]]);
});

test('a cancelled Ended cancels without a final update', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.ended('A', true);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['end', false]]);
});

test('a tap that never passes the threshold does nothing', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 2, 2);
    tracker.ended('A', false);
    assert.deepEqual(calls, []);
});

test('buttons that are not selected are ignored for the whole hold', () => {
    const {tracker, calls} = fixture({accepts: (unit, control) => unit === 'A' && control === 195});
    tracker.started('A', 416);
    tracker.moved('A', 100, 0);
    tracker.flush();
    tracker.ended('A', false);
    tracker.started('A', 195);
    tracker.moved('A', 100, 0);
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['update', 100, 0], ['end', true]]);
});

test('GNOME declining the gesture ignores the rest of the hold', () => {
    const {tracker, calls} = fixture({acceptBegin: false});
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.moved('A', 20, 0);
    tracker.flush();
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal']]);
});

test('GNOME cancelling during an update stops further updates and the end call', () => {
    const {tracker, calls} = fixture({acceptUpdate: false});
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.flush();
    tracker.moved('A', 20, 0);
    tracker.flush();
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['update', 20, 0]]);
});

test('abandon (Escape in GNOME) ignores movement until the button is released', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.abandon();
    tracker.moved('A', 20, 0);
    tracker.flush();
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal']]);
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    assert.deepEqual(calls.at(-1), ['begin', 'horizontal'], 'the next hold works again');
});

test('a second device cannot interrupt a hold in progress', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.started('B', 416);
    tracker.moved('B', 0, 50);
    tracker.ended('B', false);
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['update', 20, 0], ['end', true]]);
});

test('a repeated Started from the same device cancels the stale hold', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.started('A', 416);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['end', false]]);
    assert.equal(tracker.state, 'pending');
});

test('reset cancels an active gesture once and becomes idle', () => {
    const {tracker, calls} = fixture();
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    tracker.reset();
    tracker.reset();
    tracker.ended('A', false);
    assert.deepEqual(calls, [['begin', 'horizontal'], ['end', false]]);
    assert.equal(tracker.state, 'idle');
});

test('movement before Started and non-finite movement are ignored', () => {
    const {tracker, calls} = fixture();
    tracker.moved('A', 100, 0);
    tracker.started('A', 416);
    tracker.moved('A', NaN, 0);
    tracker.moved('A', Infinity, 0);
    tracker.ended('A', false);
    assert.deepEqual(calls, []);
});

test('an end hook that throws still leaves the tracker idle', () => {
    const tracker = new GestureTracker({
        begin: () => true, update: () => true,
        end: () => {
            throw new Error('boom');
        },
    });
    tracker.started('A', 416);
    tracker.moved('A', 20, 0);
    assert.throws(() => tracker.ended('A', false), /boom/);
    assert.equal(tracker.state, 'idle');
});

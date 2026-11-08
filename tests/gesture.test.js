import test from 'node:test';
import assert from 'node:assert/strict';
import {COUNTS_PER_MM, FlickDetector, GestureTracker, buttonId, classify} from '../extension/gesture.js';

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

// mm/s → counts per 8 ms report at 1000 DPI
const perReport = mmPerSecond => mmPerSecond * COUNTS_PER_MM * 8 / 1000;
const FLICK = {minSpeed: 150, keepRatio: 0.5};

function feed(detector, speedsMmPerSecond, {start = 0, sign = 1} = {}) {
    let time = start, position = 0;
    for (const speed of speedsMmPerSecond) {
        time += 8;
        position += sign * perReport(speed);
        detector.add(time, position);
    }
    return time;
}

test('a quick movement that is still fast at release is a flick', () => {
    const detector = new FlickDetector();
    const end = feed(detector, [100, 200, 300, 300, 280, 260, 250]);
    const result = detector.judge(end + 2, FLICK);
    assert.equal(result.flick, true);
    assert.ok(result.peak > 250 && result.peak < 310, `peak ${result.peak}`);
    assert.ok(result.release > 150);
});

test('flicks work in either direction', () => {
    const detector = new FlickDetector();
    const end = feed(detector, [200, 300, 300, 280], {sign: -1});
    assert.equal(detector.judge(end + 2, FLICK).flick, true);
});

test('a slow steady drag is not a flick', () => {
    const detector = new FlickDetector();
    const end = feed(detector, Array(30).fill(60));
    const result = detector.judge(end + 2, FLICK);
    assert.equal(result.flick, false);
    assert.ok(Math.abs(result.peak - 60) < 2, `peak ${result.peak}`);
});

test('stopping before letting go is not a flick', () => {
    const detector = new FlickDetector();
    const end = feed(detector, [200, 300, 300, 300]);
    assert.equal(detector.judge(end + 200, FLICK).flick, false, 'paused 200 ms before release');
    assert.equal(detector.judge(end + 2, FLICK).flick, true, 'same movement released at once');
});

test('slowing down a lot after the fastest moment is not a flick', () => {
    const detector = new FlickDetector();
    const end = feed(detector, [300, 300, 300, 300, 300, 300, 300, 80, 80, 80, 80, 80, 80, 80, 300]);
    assert.equal(detector.judge(end + 2, FLICK).flick, false);
});

test('changing direction is not a flick, but a little jitter is', () => {
    const reversed = new FlickDetector();
    let end = feed(reversed, [300, 300, 300, 300]);
    end = feed(reversed, [300, 300], {start: end, sign: -1});
    // continue forward from where the reversal left off
    const backAt = reversed._samples.at(-1).position;
    for (let i = 1; i <= 8; i++)
        reversed.add(end + i * 8, backAt + i * perReport(300));
    assert.equal(reversed.judge(end + 66, FLICK).flick, false);
    assert.ok(reversed.judge(end + 66, FLICK).backtrack > 20);

    const jitter = new FlickDetector();
    const times = [8, 16, 24, 32, 40, 48, 56];
    const positions = [8, 20, 18, 35, 52, 70, 88]; // 2 counts back at one report
    times.forEach((t, i) => jitter.add(t, positions[i]));
    assert.equal(jitter.judge(58, {minSpeed: 30, keepRatio: 0.5}).flick, true); // peaks near 41 mm/s
});

test('the tracker reports a flick to the end hook only when enabled and not cancelled', () => {
    let time = 0;
    const ends = [];
    const tracker = new GestureTracker({
        begin: () => true, update: () => true,
        end: (commit, info) => ends.push([commit, info.flick]),
        now: () => time,
    });
    const hold = ({cancel = false} = {}) => {
        tracker.started('A', 416);
        for (const speed of [200, 300, 300, 280]) {
            time += 8;
            tracker.moved('A', -perReport(speed), 0);
        }
        time += 2;
        tracker.ended('A', cancel);
    };
    hold();
    tracker.flick = {...tracker.flick, enabled: true};
    hold();
    hold({cancel: true});
    assert.deepEqual(ends, [[true, false], [true, true], [false, false]]);
    assert.equal(tracker.lastFlick.flick, true);
});

test('an overview hold is judged on vertical movement', () => {
    let time = 0;
    const ends = [];
    const tracker = new GestureTracker({
        begin: () => true, update: () => true,
        end: (commit, info) => ends.push(info.flick), now: () => time,
    });
    tracker.flick = {enabled: true, minSpeed: 150, keepRatio: 0.5};
    tracker.started('A', 416);
    for (const speed of [200, 300, 300, 280]) {
        time += 8;
        tracker.moved('A', perReport(20), -perReport(speed));
    }
    tracker.ended('A', false);
    assert.deepEqual(ends, [true]);
});

test('movement arriving right after the press is not mistaken for a burst of speed', () => {
    const detector = new FlickDetector(0);
    detector.add(1, 15); // first report 1 ms after the press
    for (let t = 9; t <= 41; t += 8)
        detector.add(t, 15 + (t - 1) / 8 * 15);
    const result = detector.judge(43, {minSpeed: 30, keepRatio: 0.5});
    assert.ok(result.peak < 60, `peak ${result.peak} should be near 48 mm/s`);
    assert.equal(result.flick, true);
});

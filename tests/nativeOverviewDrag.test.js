import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeOverviewDrag} from '../extension/nativeOverviewDrag.js';

function fixture({start = 0, enabled = true, failEnd = false} = {}) {
    const calls = [];
    const adjustment = {value: start, gestureInProgress: false};
    const controls = {
        _stateAdjustment: adjustment,
        gestureProgress(progress) {
            adjustment.value = progress;
            calls.push(['controls', progress]);
        },
        gestureEnd(target, duration) {
            adjustment.value = target;
            adjustment.gestureInProgress = false;
            calls.push(['controls-end', target, duration]);
        },
    };
    const overview = {
        _overview: {controls},
        _swipeTracker: {enabled, _state: 0},
        animationInProgress: false,
        visible: start > 0,
        _gestureBegin(tracker) {
            calls.push(['begin']);
            adjustment.gestureInProgress = true;
            tracker.confirmSwipe(1000, [0, 1, 2], start, start);
        },
        _gestureUpdate(_tracker, progress) {
            assert.ok(progress > 0, 'outer native update ignores exact zero');
            this.visible = true;
            adjustment.value = progress;
            calls.push(['update', progress]);
        },
        _gestureEnd(_tracker, duration, target) {
            calls.push(['end', target, duration]);
            if (failEnd)
                throw new Error('end failed');
            this.visible = target > 0;
            adjustment.value = target;
            adjustment.gestureInProgress = false;
        },
    };
    return {overview, adjustment, calls};
}

test('upward motion feeds fractional progress into native overview lifecycle', () => {
    const {overview, adjustment, calls} = fixture();
    const drag = new NativeOverviewDrag(overview);
    assert.equal(overview._swipeTracker.enabled, false);
    assert.equal(drag.move(-200, 1, 1), 0.24);
    assert.equal(adjustment.value, 0.24);
    assert.deepEqual(calls.at(-1), ['update', 0.24]);
    drag.finish(true);
    assert.deepEqual(calls.at(-1), ['end', 0, 0]);
    assert.equal(overview.visible, false);
    assert.equal(overview._swipeTracker.enabled, true);
});

test('past halfway commits overview and cannot spill into app grid', () => {
    const {overview, calls} = fixture();
    const drag = new NativeOverviewDrag(overview);
    assert.ok(Math.abs(drag.move(-400, 1, 1) - 0.56) < 1e-12);
    assert.equal(drag.move(-5000, 1, 1), 1);
    drag.finish(true);
    assert.deepEqual(calls.at(-1), ['end', 1, 0]);
    assert.equal(overview.visible, true);
});

test('reversal to exact zero updates controls before native cancel/hide completion', () => {
    const {overview, adjustment, calls} = fixture();
    const drag = new NativeOverviewDrag(overview);
    drag.move(-500);
    assert.equal(drag.move(0), 0);
    assert.equal(adjustment.value, 0);
    assert.deepEqual(calls.at(-1), ['controls', 0]);
    drag.finish(false);
    assert.deepEqual(calls.at(-1), ['end', 0, 0]);
});

test('cancel before positive progress clears preparation without illegal visibility transition', () => {
    const {overview, adjustment, calls} = fixture();
    const drag = new NativeOverviewDrag(overview);
    drag.move(100); // A downward drag from desktop cannot open overview.
    drag.finish(false);
    assert.deepEqual(calls, [['begin'], ['controls-end', 0, 0]]);
    assert.equal(adjustment.gestureInProgress, false);
    assert.equal(overview.visible, false);
});

test('downward movement from overview closes it, while cancellation keeps it open', () => {
    const {overview, calls} = fixture({start: 1});
    let drag = new NativeOverviewDrag(overview);
    drag.move(600);
    drag.finish(false);
    assert.deepEqual(calls.at(-1), ['end', 1, 0]);
    assert.equal(overview.visible, true);
    drag = new NativeOverviewDrag(overview);
    drag.move(600);
    drag.finish(true);
    assert.deepEqual(calls.at(-1), ['end', 0, 0]);
    assert.equal(overview.visible, false);
});

test('native tracker is restored even if completion fails; finish is idempotent', () => {
    const {overview, calls} = fixture({failEnd: true});
    const drag = new NativeOverviewDrag(overview);
    drag.move(-600);
    assert.throws(() => drag.finish(true), /end failed/);
    assert.equal(overview._swipeTracker.enabled, true);
    const count = calls.length;
    drag.finish(false);
    assert.equal(calls.length, count);
});

test('active native gestures are left untouched', () => {
    const {overview, adjustment} = fixture();
    adjustment.gestureInProgress = true;
    overview._swipeTracker._state = 1;
    assert.throws(() => new NativeOverviewDrag(overview), /native touchpad swipe/);
    assert.equal(adjustment.gestureInProgress, true);
});

test('upward movement from the window overview stays at the window overview', () => {
    const {overview, calls} = fixture({start: 1});
    const drag = new NativeOverviewDrag(overview);
    assert.equal(drag.move(-600), 1);
    drag.finish(true);
    assert.deepEqual(calls.at(-1), ['end', 1, 0]);
});

test('a gesture from GNOME native app grid can return to the window overview', () => {
    const {overview, adjustment} = fixture({start: 2});
    const drag = new NativeOverviewDrag(overview);
    assert.equal(drag.move(700), 1.3);
    drag.finish(true);
    assert.equal(adjustment.value, 1);
    assert.equal(adjustment.gestureInProgress, false);
});

test('failed native hidden-to-hiding completion is recovered once its tracker is idle', () => {
    const {overview, adjustment, calls} = fixture();
    // GNOME resets its tracker before emitting end; the invalid outer
    // transition then throws before clearing this controls flag.
    overview._swipeTracker._state = 0;
    adjustment.gestureInProgress = true;
    const drag = new NativeOverviewDrag(overview);
    assert.deepEqual(calls.slice(0, 2), [['controls-end', 0, 0], ['begin']]);
    drag.move(-600);
    drag.finish(true);
    assert.equal(overview.visible, true);
    assert.equal(adjustment.gestureInProgress, false);
    assert.equal(overview._swipeTracker.enabled, true);
});

test('hidden fractional progress is reconciled only when the native tracker is idle', () => {
    const {overview, adjustment, calls} = fixture();
    adjustment.value = 0.15;
    const drag = new NativeOverviewDrag(overview);
    assert.deepEqual(calls[0], ['controls-end', 0, 0]);
    assert.equal(adjustment.value, 0);
    drag.finish(false);
});

test('a stale flag is not repaired during a live overview transition', () => {
    const {overview, adjustment, calls} = fixture();
    adjustment.gestureInProgress = true;
    adjustment.get_transition = () => ({});
    assert.throws(() => new NativeOverviewDrag(overview), /active animation/);
    assert.equal(adjustment.gestureInProgress, true);
    assert.equal(calls.length, 0);
});

test('unknown native tracker state is left untouched rather than assumed idle', () => {
    const {overview, adjustment, calls} = fixture();
    delete overview._swipeTracker._state;
    adjustment.gestureInProgress = true;
    assert.throws(() => new NativeOverviewDrag(overview), /busy/);
    assert.equal(calls.length, 0);
});

test('begin failure restores tracker and gesture flag', () => {
    const {overview, adjustment} = fixture();
    overview._gestureBegin = () => {
        adjustment.gestureInProgress = true;
        throw new Error('prepare failed');
    };
    assert.throws(() => new NativeOverviewDrag(overview), /prepare failed/);
    assert.equal(overview._swipeTracker.enabled, true);
    assert.equal(adjustment.gestureInProgress, false);
});

test('the settle duration is handed to GNOME for the overview', () => {
    const {overview, calls} = fixture();
    const drag = new NativeOverviewDrag(overview);
    drag.move(-600);
    drag.finish(true, 0, {duration: (progress, end) => {
        calls.push(['duration-asked', progress, end]);
        return 250;
    }});
    assert.deepEqual(calls.slice(-2), [['duration-asked', 0.6, 1], ['end', 1, 250]]);
});

test('an upward flick from the window overview does not reach the app grid', () => {
    const {overview, calls} = fixture({start: 1});
    const drag = new NativeOverviewDrag(overview);
    drag.move(-100);
    drag.finish(true, 0, {flick: true});
    assert.deepEqual(calls.at(-1), ['end', 1, 0]);
});

test('a downward flick from the window overview closes it however short', () => {
    const {overview, calls} = fixture({start: 1});
    const drag = new NativeOverviewDrag(overview);
    drag.move(80);
    drag.finish(true, 0, {flick: true});
    assert.deepEqual(calls.at(-1), ['end', 0, 0]);
});

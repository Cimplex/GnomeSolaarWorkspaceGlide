import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeDrag} from '../extension/nativeDrag.js';

function fixture({start = 1, failActivation = false, enabled = true} = {}) {
    const calls = [];
    const workspaces = [0, 1, 2, 3].map(index => ({
        index,
        active: index === start,
        activate(timestamp) {
            calls.push(['activate', index, timestamp]);
            assert.equal(controller._switchData.gestureActivated, true);
            if (failActivation)
                throw new Error('activation failed');
        },
    }));
    const group = {
        progress: start,
        getWorkspaceProgress: workspace => workspace.index,
        findClosestWorkspace: progress => workspaces[Math.round(progress)],
    };
    const controller = {
        _swipeTracker: {enabled},
        _switchData: null,
        _switchWorkspaceBegin(tracker, monitor) {
            calls.push(['begin', monitor]);
            this._switchData = {baseMonitorGroup: group, monitors: [group]};
            tracker.confirmSwipe(1000, [0, 1, 2, 3], start, start);
        },
        _switchWorkspaceUpdate(_tracker, progress) {
            group.progress = progress;
        },
        _finishWorkspaceSwitch(data) {
            assert.equal(data, this._switchData);
            calls.push(['finish']);
            this._switchData = null;
        },
    };
    return {controller, calls, group};
}

test('motion follows pixels continuously and can reverse before release', () => {
    const {controller, group} = fixture();
    const drag = new NativeDrag(controller, 0);
    assert.equal(controller._swipeTracker.enabled, false);
    assert.ok(Math.abs(drag.move(-235) - 1.235) < 1e-12);
    assert.ok(Math.abs(group.progress - 1.235) < 1e-12);
    assert.ok(Math.abs(drag.move(-235) - 1.235) < 1e-12);
    assert.equal(drag.move(-100), 1.1);
    assert.equal(drag.move(250), 0.75);
    drag.finish(false, 42);
    assert.equal(controller._swipeTracker.enabled, true);
});

test('sensitivity multiplies travel without changing native workspace distance', () => {
    const {controller, group} = fixture();
    const drag = new NativeDrag(controller, 0);
    assert.equal(drag.move(-200, false, 3), 1.6);
    assert.equal(group.progress, 1.6);
    assert.equal(drag.distance, 1000);
    assert.throws(() => drag.move(100, false, 0), /Invalid/);
    assert.throws(() => drag.move(NaN), /Invalid/);
    drag.finish(false, 42);
});

test('progressive acceleration extends larger workspace drags and reverses exactly', () => {
    const {controller} = fixture();
    const drag = new NativeDrag(controller, 0);
    const small = drag.move(-50, false, 1, 1) - drag.start;
    const large = drag.move(-300, false, 1, 1) - drag.start;
    assert.ok(large / 0.3 > small / 0.05);
    assert.ok(Math.abs(drag.move(-50, false, 1, 1) - (drag.start + small)) < 1e-12);
    assert.equal(drag.move(0, false, 1, 1), drag.start);
    drag.finish(false, 42);
});

test('a drag cannot cross more than one workspace in either direction', () => {
    const {controller} = fixture();
    const drag = new NativeDrag(controller, 0);
    assert.equal(drag.move(-5000), 2);
    assert.equal(drag.move(5000), 0);
    drag.finish(false, 42);
});

test('the first workspace clamps missing previous workspace; RTL reverses direction', () => {
    const {controller} = fixture({start: 0});
    const drag = new NativeDrag(controller, 0);
    assert.equal(drag.move(500), 0);
    assert.equal(drag.move(500, true), 0.5);
    drag.finish(false, 42);
});

test('Standard preserves the current horizontal slide and Natural reverses it', () => {
    const {controller} = fixture();
    const drag = new NativeDrag(controller, 0);
    assert.equal(drag.move(200, false, 1, 0, false), 0.8);
    assert.equal(drag.move(200, false, 1, 0, true), 1.2);
    assert.equal(drag.move(-200, false, 1, 0, true), 0.8);
    assert.equal(drag.move(200, true, 1, 0, false), 1.2);
    assert.equal(drag.move(200, true, 1, 0, true), 0.8);
    drag.finish(false, 42);
});

test('release after halfway snaps and activates the nearest workspace before cleanup', () => {
    const {controller, calls, group} = fixture();
    const drag = new NativeDrag(controller, 0);
    drag.move(-600);
    drag.finish(true, 42);
    assert.equal(group.progress, 2);
    assert.deepEqual(calls, [['begin', 0], ['activate', 2, 42], ['finish']]);
    assert.equal(controller._switchData, null);
    assert.equal(controller._swipeTracker.enabled, true);
});

test('release before halfway returns to the active workspace without activation', () => {
    const {controller, calls, group} = fixture();
    const drag = new NativeDrag(controller, 0);
    drag.move(-400);
    drag.finish(true, 42);
    assert.equal(group.progress, 1);
    assert.deepEqual(calls, [['begin', 0], ['finish']]);
});

test('cancel and repeated cleanup never activate a workspace', () => {
    const {controller, calls} = fixture();
    const drag = new NativeDrag(controller, 0);
    drag.move(-900);
    drag.finish(false, 42);
    drag.finish(false, 42);
    assert.deepEqual(calls, [['begin', 0], ['finish']]);
});

test('activation errors still finish the native switch and restore tracker state', () => {
    const {controller, calls} = fixture({failActivation: true, enabled: false});
    const drag = new NativeDrag(controller, 0);
    drag.move(-900);
    assert.throws(() => drag.finish(true, 42), /activation failed/);
    assert.equal(controller._switchData, null);
    assert.equal(controller._swipeTracker.enabled, false);
    assert.deepEqual(calls.at(-1), ['finish']);
});

test('a busy controller is left untouched', () => {
    const {controller} = fixture();
    const existing = {};
    controller._switchData = existing;
    assert.throws(() => new NativeDrag(controller, 0), /already has/);
    assert.equal(controller._switchData, existing);
    assert.equal(controller._swipeTracker.enabled, true);
});

test('a partially prepared native switch is cleaned up if begin throws', () => {
    const {controller, calls} = fixture();
    controller._switchWorkspaceBegin = () => {
        controller._switchData = {};
        throw new Error('native setup failed');
    };
    assert.throws(() => new NativeDrag(controller, 0), /native setup failed/);
    assert.equal(controller._switchData, null);
    assert.equal(controller._swipeTracker.enabled, true);
    assert.deepEqual(calls, [['finish']]);
});

test('interrupted native gestures are not finished or updated a second time', () => {
    const {controller, calls} = fixture();
    const drag = new NativeDrag(controller, 0);
    controller._switchData = null;
    assert.throws(() => drag.move(-100), /ended/);
    drag.finish(false, 42);
    assert.deepEqual(calls, [['begin', 0]]);
    assert.equal(controller._swipeTracker.enabled, true);
});

function easing(fixtureResult) {
    const eases = [];
    const {controller, group} = fixtureResult;
    group.ease_property = (property, value, params) => eases.push({property, value, params});
    return {...fixtureResult, eases, controller};
}

test('with a duration the release eases to the target and finishes when the ease completes', () => {
    const {controller, calls, eases, group} = easing(fixture());
    const drag = new NativeDrag(controller, 0);
    drag.move(-700);
    let stamp = 0;
    drag.finish(true, () => ++stamp, {duration: (progress, end) => (end - progress) * 1000, mode: 'ease-out-cubic'});
    assert.equal(controller._swipeTracker.enabled, true, 'touchpad swipes work again at once');
    assert.equal(eases.length, 1);
    assert.equal(eases[0].property, 'progress');
    assert.equal(eases[0].value, 2);
    assert.equal(eases[0].params.mode, 'ease-out-cubic');
    assert.ok(Math.abs(eases[0].params.duration - 300) < 1e-6);
    assert.equal(group.progress, 1.7, 'not snapped');
    assert.deepEqual(calls, [['begin', 0]], 'nothing activated or finished yet');
    eases[0].params.onComplete();
    assert.deepEqual(calls, [['begin', 0], ['activate', 2, 1], ['finish']]);
});

test('a zero duration still snaps at once', () => {
    const {controller, calls, eases} = easing(fixture());
    const drag = new NativeDrag(controller, 0);
    drag.move(-700);
    drag.finish(true, 42, {duration: () => 0});
    assert.equal(eases.length, 0);
    assert.deepEqual(calls, [['begin', 0], ['activate', 2, 42], ['finish']]);
});

test('a cancelled gesture never animates', () => {
    const {controller, eases, calls} = easing(fixture());
    const drag = new NativeDrag(controller, 0);
    drag.move(-700);
    drag.finish(false, 42, {duration: () => 300});
    assert.equal(eases.length, 0);
    assert.deepEqual(calls, [['begin', 0], ['finish']]);
});

test('a new gesture can take over a settle that is still animating', () => {
    const {controller, calls, eases, group} = easing(fixture());
    controller._switchWorkspaceBegin = function (tracker, monitor) {
        calls.push(['begin', monitor]);
        if (!this._switchData?.gestureActivated)
            this._switchData = {baseMonitorGroup: group, monitors: [group]};
        // GNOME settles a taken-over swipe around where it was heading.
        tracker.confirmSwipe(1000, [0, 1, 2, 3], group.progress, Math.round(group.progress));
    };
    const first = new NativeDrag(controller, 0);
    first.move(-700);
    first.finish(true, 1, {duration: () => 300});
    group.progress = 1.8; // part way through the ease
    const second = new NativeDrag(controller, 0);
    assert.equal(second.start, 1.8);
    assert.equal(second.base, 2);
    second.move(-50); // a short flick onward
    second.finish(true, 2, {flick: true, duration: () => 0});
    assert.deepEqual(calls.slice(-2), [['activate', 3, 2], ['finish']]);
    assert.equal(eases.length, 1, 'only the first settle animated');
    eases[0].params.onComplete(); // a removed transition would not call this, but even so:
    assert.equal(calls.filter(call => call[0] === 'finish').length, 1, 'the old settle does not finish the switch again');
    assert.equal(calls.filter(call => call[0] === 'activate').length, 1, 'nor activate its old target');
});

test('a flick at the last workspace stays there', () => {
    const {controller, calls} = fixture({start: 3});
    const drag = new NativeDrag(controller, 0);
    drag.move(-50);
    drag.finish(true, 7, {flick: true});
    assert.deepEqual(calls, [['begin', 0], ['finish']]);
});

test('an old settle completing during the gesture that took it over does nothing', () => {
    const {controller, calls, eases, group} = easing(fixture());
    controller._switchWorkspaceBegin = function (tracker, monitor) {
        calls.push(['begin', monitor]);
        if (!this._switchData?.gestureActivated)
            this._switchData = {baseMonitorGroup: group, monitors: [group]};
        tracker.confirmSwipe(1000, [0, 1, 2, 3], group.progress, Math.round(group.progress));
    };
    const first = new NativeDrag(controller, 0);
    first.move(-700);
    first.finish(true, 1, {duration: () => 300});
    const second = new NativeDrag(controller, 0);
    eases[0].params.onComplete();
    assert.equal(calls.some(call => call[0] === 'activate' || call[0] === 'finish'), false);
    second.move(10);
    assert.equal(controller._switchData, second.data, 'the switch is still live for the new gesture');
    second.finish(false, 2);
});

test('a flick taking over before the halfway point still carries on past the old target', () => {
    const {controller, calls, group} = easing(fixture());
    controller._switchWorkspaceBegin = function (tracker, monitor) {
        calls.push(['begin', monitor]);
        if (!this._switchData?.gestureActivated)
            this._switchData = {baseMonitorGroup: group, monitors: [group]};
        tracker.confirmSwipe(1000, [0, 1, 2, 3], group.progress, Math.round(group.progress));
    };
    const first = new NativeDrag(controller, 0);
    first.move(-300);
    first.finish(true, 1, {flick: true, duration: () => 400}); // heading for 2
    group.progress = 1.4; // GNOME would call 1 the nearest
    const second = new NativeDrag(controller, 0);
    assert.equal(second.base, 2);
    second.move(-200);
    second.finish(true, 2, {flick: true, duration: () => 0});
    assert.deepEqual(calls.slice(-2), [['activate', 3, 2], ['finish']]);
});

test('without a settle in flight the base is the nearest workspace', () => {
    const {controller} = fixture();
    const drag = new NativeDrag(controller, 0);
    assert.equal(drag.base, 1);
    drag.finish(false, 0);
});

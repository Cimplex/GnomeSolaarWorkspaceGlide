// Exercise the actual extension lifecycle with GNOME's boundary APIs stubbed.
// This guards against creating pointer barriers during glides and checks that
// Solaar's Started/Moved/Ended signals drive exactly one GNOME gesture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GestureTracker, buttonId} from '../extension/gesture.js';
import {PointerHold} from '../extension/pointerHold.js';

let moduleSerial = 0;
async function fixture({delay = 350, barrierFails = false} = {}) {
    const trace = [];
    const timers = new Map();
    const laters = [];
    let stageHandler = null;
    let serial = 0;
    const schedule = (milliseconds, callback) => {
        const id = ++serial;
        timers.set(id, {milliseconds, callback});
        return id;
    };
    const cancelTimer = id => timers.delete(id);
    const hold = new PointerHold({
        createBarrier() {
            trace.push('barrier-created');
            if (barrierFails)
                throw new Error('backend cannot create barrier');
            return {destroy: () => trace.push('barrier-destroyed')};
        },
        schedule, cancelTimer,
    });
    class Drag {
        constructor() {
            this.distance = 1000;
            this.start = 1;
            this.progress = 1;
        }
        move(...args) {
            trace.push(['move', ...args]);
            this.presented = true;
            return this.progress = 0.6;
        }
        finish(commit) { trace.push(['finish', commit]); }
    }
    const Main = {
        overview: {visible: false, animationInProgress: false},
        actionMode: 1,
        layoutManager: {primaryMonitor: {index: 0, x: 0, y: 0, width: 2000}},
        wm: {_workspaceAnimation: {}},
        uiGroup: {add_child() {}},
        pushModal: () => ({is_revoked: () => false}),
        popModal() {},
        notify: (_title, message) => trace.push(['notify', message]),
    };
    const context = {
        Main,
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, timeout_add: (_p, ms, fn) => schedule(ms, fn), source_remove: cancelTimer,
            get_home_dir: () => '/home/demo', build_filenamev: parts => parts.join('/')},
        Shell: {ActionMode: {NORMAL: 1, OVERVIEW: 2, NONE: 0}},
        Clutter: {TextDirection: {RTL: 1}, get_default_text_direction: () => 0,
            EventType: {KEY_PRESS: 1, BUTTON_PRESS: 2, MOTION: 3, BUTTON_RELEASE: 4}, KEY_Escape: 0xff1b,
            EVENT_STOP: true},
        Meta: {LaterType: {BEFORE_REDRAW: 0}},
        St: {
            Label: class {
                constructor(properties) { Object.assign(this, properties); trace.push('label-created'); }
                get_preferred_width() { return [0, 600]; }
                set_position() {}
                destroy() { trace.push('label-destroyed'); }
            },
            Settings: {get: () => ({slow_down_factor: 0})},
        },
        Extension: class {},
        NativeDrag: Drag,
        NativeOverviewDrag: Drag,
        PointerHold,
        GestureTracker,
        buttonId,
        global: {
            compositor: {get_laters: () => ({
                add: (_type, callback) => {
                    laters.push(callback);
                    return laters.length;
                },
                remove() {},
            })},
            workspace_manager: {layout_rows: 1, n_workspaces: 3},
            stage: {connect: (_signal, handler) => {
                stageHandler = handler;
                return ++serial;
            }, disconnect() {
                stageHandler = null;
            }},
            get_pointer: () => [100, 200],
            get_current_time: () => 1,
        },
        console: {log() {}, error: message => trace.push(['error', message])},
    };
    const source = (await readFile(new URL('../extension/extension.js', import.meta.url), 'utf8'))
        .replace(/^import .*;\n/gm, '');
    globalThis.__workspaceGlideFixture = context;
    const prefix = `const {Main, GLib, Meta, Shell, Clutter, St, Extension, NativeDrag, NativeOverviewDrag, PointerHold, GestureTracker, buttonId, global, console} = globalThis.__workspaceGlideFixture;\n`;
    let Class;
    try {
        ({default: Class} = await import(`data:text/javascript;base64,${Buffer.from(prefix + source + `\n// fixture ${++moduleSerial}`).toString('base64')}`));
    } finally {
        delete globalThis.__workspaceGlideFixture;
    }
    const extension = new Class();
    Object.assign(extension, {
        _pointerHold: hold, _sensitivity: 3, _acceleration: 1,
        _releaseDelay: delay, _naturalDirection: false,
        _debugProgress: false, _listenAll: true, _selected: new Set(),
        _drag: null, _mode: null, _kind: null, _laterId: 0,
    });
    // The same wiring as enable(), without the D-Bus and settings parts.
    extension._tracker = new GestureTracker({
        accepts: (unitId, control) => extension._acceptsButton(unitId, control),
        begin: kind => extension._arm('stream', kind),
        update: (x, y) => extension._streamUpdate(x, y),
        end: commit => extension._stop(commit, true),
        requestFlush: () => extension._requestFlush(),
    });
    const frame = () => {
        for (const callback of laters.splice(0))
            callback();
    };
    const key = symbol => stageHandler?.(null, {type: () => 1, get_key_symbol: () => symbol});
    return {extension, trace, timers, frame, key, tracker: extension._tracker};
}

const moves = trace => trace.filter(entry => Array.isArray(entry) && entry[0] === 'move');
const finishes = trace => trace.filter(entry => Array.isArray(entry) && entry[0] === 'finish');

test('button glides create no pointer barriers until after native completion', async () => {
    for (const kind of ['horizontal', 'overview']) {
        const {extension, trace, timers} = await fixture();
        assert.equal(extension._arm('stream', kind), true);
        extension._move(100, -100);
        extension._move(300, -300);
        assert.equal(trace.filter(entry => entry === 'barrier-created').length, 0);
        extension._stop(true);
        assert.equal(trace.filter(entry => entry === 'barrier-created').length, 4);
        const finished = trace.findIndex(entry => Array.isArray(entry) && entry[0] === 'finish');
        assert.ok(finished < trace.indexOf('barrier-created'));
        assert.equal([...timers.values()].at(-1).milliseconds, 350);
    }
});

test('release delay Off bypasses all barriers throughout a button gesture', async () => {
    const {extension, trace, timers} = await fixture({delay: 0});
    assert.equal(extension._arm('stream', 'horizontal'), true);
    extension._move(300, 0);
    extension._stop(true);
    assert.equal(trace.filter(entry => entry === 'barrier-created').length, 0);
    assert.equal(timers.size, 0);
});

test('ordinary drag test and cancelled button gestures never confine the pointer', async () => {
    for (const [mode, commit] of [['pointer', true], ['stream', false]]) {
        const {extension, trace} = await fixture();
        assert.equal(extension._arm(mode, 'horizontal'), true);
        extension._move(300, 0);
        extension._stop(commit);
        assert.equal(trace.filter(entry => entry === 'barrier-created').length, 0);
    }
});

test('post-release barrier failure cannot fail a completed native gesture', async () => {
    const {extension, trace, timers} = await fixture({barrierFails: true});
    assert.equal(extension._arm('stream', 'horizontal'), true);
    extension._move(300, 0);
    assert.doesNotThrow(() => extension._stop(true));
    assert.ok(trace.some(entry => Array.isArray(entry) && entry[0] === 'finish' && entry[1] === true));
    assert.ok(trace.some(entry => Array.isArray(entry) && entry[0] === 'error'));
    assert.equal(timers.size, 0);
});

test('a new gesture clears the prior cooldown without creating new active barriers', async () => {
    const {extension, trace} = await fixture();
    extension._arm('stream', 'horizontal');
    extension._move(300, 0);
    extension._stop(true);
    extension._arm('stream', 'horizontal');
    assert.equal(trace.filter(entry => entry === 'barrier-destroyed').length, 4);
    assert.equal(trace.filter(entry => entry === 'barrier-created').length, 4);
    extension._move(300, 0);
    extension._stop(false);
});

test('direction is frozen per gesture and applied only to horizontal workspace motion', async () => {
    const {extension, trace} = await fixture({delay: 0});
    extension._naturalDirection = true;
    extension._arm('stream', 'horizontal');
    extension._naturalDirection = false;
    extension._move(300, 0);
    assert.deepEqual(trace.find(entry => Array.isArray(entry) && entry[0] === 'move'), ['move', 300, false, 3, 1, true]);
    extension._stop(true);
    trace.length = 0;
    extension._naturalDirection = true;
    extension._arm('stream', 'overview');
    extension._move(300, -200);
    assert.deepEqual(trace.find(entry => Array.isArray(entry) && entry[0] === 'move'), ['move', -200, 3, 1]);
    extension._stop(true);
});

test('default gestures render no debug overlay and do not need a label to update', async () => {
    const {extension, trace} = await fixture({delay: 0});
    extension._arm('stream', 'horizontal');
    extension._move(300, 0);
    extension._stop(true);
    assert.equal(trace.includes('label-created'), false);
    assert.equal(extension._label, null);
});

test('enabling progress creates a live badge and turning it off removes it', async () => {
    const {extension, trace} = await fixture({delay: 0});
    extension._debugProgress = true;
    extension._arm('stream', 'horizontal');
    assert.equal(trace.filter(entry => entry === 'label-created').length, 1);
    extension._move(300, 0);
    assert.match(extension._label.text, /progress 0.600/);
    extension._debugProgress = false;
    extension._refreshProgressLabel();
    assert.equal(extension._label, null);
    assert.equal(trace.filter(entry => entry === 'label-destroyed').length, 1);
    extension._move(400, 0);
    extension._stop(true);
});

test('a Movement Stream hold slides workspaces once per frame and settles on release', async () => {
    const {extension, trace, frame, tracker} = await fixture({delay: 0});
    tracker.started('12D5FD67', 416);
    tracker.moved('12D5FD67', 4, 0);
    assert.equal(extension._drag, null, 'no gesture before the direction threshold');
    tracker.moved('12D5FD67', 6, 1);
    tracker.moved('12D5FD67', 90, 0);
    assert.equal(extension._kind, 'horizontal');
    assert.equal(moves(trace).length, 0, 'movement waits for the frame');
    frame();
    assert.deepEqual(moves(trace), [['move', 100, false, 3, 1, false]]);
    tracker.moved('12D5FD67', 50, 0);
    tracker.ended('12D5FD67', false);
    assert.deepEqual(moves(trace).at(-1), ['move', 150, false, 3, 1, false], 'release applies the last movement');
    assert.deepEqual(finishes(trace), [['finish', true]]);
    assert.equal(extension._drag, null);
    frame();
    assert.equal(moves(trace).length, 2, 'a frame after release does nothing');
});

test('a cancelled Ended from Solaar cancels the gesture', async () => {
    const {trace, tracker} = await fixture({delay: 0});
    tracker.started('A', 416);
    tracker.moved('A', 0, -50);
    tracker.ended('A', true);
    assert.deepEqual(finishes(trace), [['finish', false]]);
});

test('Escape cancels and the rest of the hold is ignored until release', async () => {
    const {extension, trace, frame, key, tracker} = await fixture({delay: 0});
    tracker.started('A', 416);
    tracker.moved('A', 50, 0);
    key(0xff1b);
    assert.deepEqual(finishes(trace), [['finish', false]]);
    tracker.moved('A', 0, -200);
    frame();
    tracker.ended('A', false);
    assert.equal(finishes(trace).length, 1);
    assert.equal(extension._drag, null);
    tracker.started('A', 416);
    tracker.moved('A', 50, 0);
    assert.equal(extension._kind, 'horizontal', 'the next hold glides again');
});

test('a hold that GNOME declines does not notify or retry for the rest of the hold', async () => {
    const {extension, trace, tracker} = await fixture({delay: 0});
    extension._drag = {busy: true}; // e.g. a drag test already running
    tracker.started('A', 416);
    tracker.moved('A', 50, 0);
    tracker.moved('A', 50, 0);
    assert.equal(tracker.state, 'rejected');
    assert.equal(trace.some(entry => Array.isArray(entry) && entry[0] === 'notify'), false);
});

test('only selected buttons glide when listen-all is off', async () => {
    const {extension, tracker} = await fixture({delay: 0});
    extension._listenAll = false;
    extension._selected = new Set(['A:195']);
    tracker.started('A', 416);
    tracker.moved('A', 50, 0);
    assert.equal(extension._drag, null);
    tracker.ended('A', false);
    tracker.started('A', 195);
    tracker.moved('A', 50, 0);
    assert.equal(extension._kind, 'horizontal');
});

test('Solaar leaving mid-hold cancels the gesture', async () => {
    const {extension, trace, tracker} = await fixture({delay: 0});
    tracker.started('A', 416);
    tracker.moved('A', 50, 0);
    tracker.reset();
    assert.deepEqual(finishes(trace), [['finish', false]]);
    assert.equal(extension._drag, null);
});

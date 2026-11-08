import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GestureTracker, buttonId} from './gesture.js';
import {MovementStream} from './movementStream.js';
import {NativeDrag} from './nativeDrag.js';
import {NativeOverviewDrag} from './nativeOverviewDrag.js';
import {PointerHold} from './pointerHold.js';
import {TestService} from './testService.js';

const LOG = '[SolaarWorkspaceGlide]';
const MAX_SEEN_BUTTONS = 32;
const GESTURE_TIMEOUT_MS = 30000;

// Two ways a gesture can be driven:
//   'stream'  a button held with Solaar's Movement Stream (the normal case)
//   'pointer' a left-button drag test started from the preferences window
export default class SolaarWorkspaceGlide extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._drag = null;
        this._mode = null;
        this._kind = null;
        this._laterId = 0;
        this._pointerHold = new PointerHold({
            createBarrier: ({direction, ...coordinates}) => new Meta.Barrier({
                backend: global.backend,
                ...coordinates,
                directions: Meta.BarrierDirection[direction],
                flags: Meta.BarrierFlags.STICKY,
            }),
            schedule: (milliseconds, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            cancelTimer: id => GLib.source_remove(id),
        });
        this._settingsSignal = this._settings.connect('changed', () => this._syncSettings());
        this._syncSettings();

        this._tracker = new GestureTracker({
            threshold: this._threshold,
            accepts: (unitId, control) => this._acceptsButton(unitId, control),
            begin: kind => this._arm('stream', kind),
            update: (x, y) => this._streamUpdate(x, y),
            end: commit => this._stop(commit, true),
            requestFlush: () => this._requestFlush(),
        });
        this._stream = new MovementStream({
            onStarted: (unitId, control) => {
                this._rememberButton(unitId, control);
                this._tracker.started(unitId, control);
            },
            onMoved: (unitId, dx, dy) => this._tracker.moved(unitId, dx, dy),
            onEnded: (unitId, cancelled) => this._tracker.ended(unitId, cancelled),
            onSolaar: present => {
                if (!present)
                    this._tracker.reset(); // Solaar quit or crashed mid-hold
                console.log(`${LOG} Solaar ${present ? 'is on' : 'left'} the session bus`);
            },
        });
        this._testService = new TestService(kind => this._arm('pointer', kind));

        this._lockSignal = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                this._stop(false);
        });
        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => this._stop(false));
        this._overviewSignal = Main.overview.connect('showing', () => {
            // Our own first overview update emits showing synchronously.
            if (this._kind !== 'overview')
                this._stop(false);
        });
        console.log(`${LOG} ${this.metadata['version-name']} enabled; listening for Solaar Movement Stream`);
    }

    disable() {
        this._stop(false);
        this._tracker.reset();
        this._stream.destroy();
        this._stream = null;
        this._testService.destroy();
        this._testService = null;
        this._cancelFlush();
        this._tracker = null;
        this._pointerHold.clear();
        this._pointerHold = null;
        this._settings.disconnect(this._settingsSignal);
        this._settings = null;
        Main.sessionMode.disconnect(this._lockSignal);
        Main.layoutManager.disconnect(this._monitorSignal);
        Main.overview.disconnect(this._overviewSignal);
    }

    _syncSettings() {
        this._sensitivity = this._settings.get_double('sensitivity');
        this._acceleration = this._settings.get_double('acceleration');
        this._threshold = this._settings.get_double('direction-threshold');
        this._releaseDelay = this._settings.get_uint('release-deadtime-ms');
        this._naturalDirection = this._settings.get_boolean('natural-workspace-direction');
        this._listenAll = this._settings.get_boolean('listen-all-buttons');
        this._selected = new Set(this._settings.get_strv('selected-buttons'));
        this._debugProgress = this._settings.get_boolean('debug-progress');
        if (this._tracker)
            this._tracker.threshold = this._threshold;
        this._refreshProgressLabel();
    }

    _acceptsButton(unitId, control) {
        const accepted = this._listenAll || this._selected.has(buttonId(unitId, control));
        if (this._debugProgress)
            console.log(`${LOG} hold from ${buttonId(unitId, control)}: ${accepted ? 'gliding' : 'not a selected button'}`);
        return accepted;
    }

    // Remember buttons that stream so the preferences window can list them.
    _rememberButton(unitId, control) {
        const id = buttonId(unitId, control);
        const seen = this._settings.get_strv('seen-buttons');
        if (seen.includes(id))
            return;
        this._settings.set_strv('seen-buttons', [...seen, id].slice(-MAX_SEEN_BUTTONS));
    }

    // Movement is applied once per frame however many reports arrive.
    _requestFlush() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._tracker?.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelFlush() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
    }

    _streamUpdate(x, y) {
        if (this._mode !== 'stream' || !this._drag)
            return false;
        try {
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7)
                throw new Error('Invalid movement');
            this._move(x, y);
            return true;
        } catch (error) {
            console.error(`${LOG} update: ${error.stack ?? error}`);
            this._stop(false, true);
            return false;
        }
    }

    _refreshProgressLabel() {
        if (!this._debugProgress || !this._drag) {
            this._label?.destroy();
            this._label = null;
            return;
        }
        const target = this._kind === 'overview' ? 'overview' : 'workspace';
        let text;
        if (this._updateCount === 0) {
            text = this._mode === 'stream'
                ? `Workspace Glide: ${target} gesture · Esc cancels`
                : `Workspace Glide: hold the LEFT mouse button and drag ${this._kind === 'overview' ? 'up/down' : 'left/right'} · Esc cancels`;
        } else {
            text = `Workspace Glide: progress ${this._drag.progress.toFixed(3)} · ${this._gestureSensitivity}× · release to settle · Esc cancels`;
        }
        if (!this._label) {
            this._label = new St.Label({
                text,
                style: 'background-color: rgba(20,20,25,0.94); color: white; padding: 14px 20px; border-radius: 12px; font-size: 15px;',
            });
            Main.uiGroup.add_child(this._label);
            const monitor = Main.layoutManager.primaryMonitor;
            const [, width] = this._label.get_preferred_width(-1);
            this._label.set_position(monitor.x + Math.max(0, (monitor.width - width) / 2), monitor.y + 64);
        } else {
            this._label.text = text;
        }
    }

    _decline(kind, message, notify) {
        console.log(`${LOG} declined ${kind}: ${message}`);
        if (notify)
            Main.notify('Workspace Glide', message);
        return false;
    }

    _arm(mode, kind) {
        if (this._drag)
            return this._decline(kind, `another ${this._kind} gesture is active`, false);
        const overview = kind === 'overview';
        const allowedMode = Main.actionMode === Shell.ActionMode.NORMAL ||
            (overview && Main.actionMode === Shell.ActionMode.OVERVIEW);
        if ((!overview && Main.overview.visible) || Main.overview.animationInProgress || !allowedMode) {
            if (this._debugProgress)
                console.log(`${LOG} overviewVisible=${Main.overview.visible}; animation=${Main.overview.animationInProgress}; actionMode=${Main.actionMode}`);
            return this._decline(kind, 'Close the overview or dialog, then try again.', mode === 'pointer');
        }
        if (!overview && global.workspace_manager.layout_rows === -1)
            return this._decline(kind, 'Workspace gliding needs workspaces laid out horizontally.', true);
        if (!overview && global.workspace_manager.n_workspaces < 2)
            return this._decline(kind, 'Create a second workspace first.', true);

        try {
            this._pointerHold.clear();
            const monitor = Main.layoutManager.primaryMonitor;
            this._mode = mode;
            this._kind = kind;
            this._gestureSensitivity = this._sensitivity;
            this._gestureAcceleration = this._acceleration;
            this._gestureReleaseDelay = this._releaseDelay;
            this._gestureNaturalDirection = this._naturalDirection;
            this._updateCount = 0;
            this._lastInput = [0, 0];
            this._drag = overview
                ? new NativeOverviewDrag(Main.overview)
                : new NativeDrag(Main.wm._workspaceAnimation, monitor.index);
            if (overview && mode === 'pointer')
                // Prime visibility by a subpixel amount so native overview
                // takes its grab before our mouse-test grab captures app input.
                this._drag.move(-this._drag.distance * 0.000001);
            // Overview must take its native modal grab on the first positive
            // progress update before we place our capture grab on top.
            if (!overview || mode === 'pointer')
                this._capture();

            this._refreshProgressLabel();
            this._pressX = null;
            this._eventSignal = global.stage.connect('captured-event', (_stage, event) => {
                try {
                    return this._onEvent(event);
                } catch (error) {
                    console.error(`${LOG} ${error.stack ?? error}`);
                    this._stop(false);
                    Main.notify('Workspace Glide', String(error));
                    return Clutter.EVENT_STOP;
                }
            });
            // A safety net in case Solaar's Ended never arrives.
            this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GESTURE_TIMEOUT_MS, () => {
                this._timeout = 0;
                this._stop(false);
                return GLib.SOURCE_REMOVE;
            });
            if (this._debugProgress)
                console.log(`${LOG} armed; mode=${mode}; kind=${kind}; direction=${this._gestureNaturalDirection ? 'natural' : 'standard'}; distance=${this._drag.distance}; start=${this._drag.start}; slow_down_factor=${St.Settings.get().slow_down_factor}`);
            return true;
        } catch (error) {
            console.error(`${LOG} ${String(error)}\n${error.stack ?? ''}`);
            this._stop(false);
            Main.notify('Workspace Glide', String(error));
            return false;
        }
    }

    _capture() {
        this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.NONE});
        if (this._grab.is_revoked())
            throw new Error('Could not capture mouse and keyboard for the gesture');
    }

    _move(x, y = 0) {
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const overview = this._kind === 'overview';
        const progress = overview
            ? this._drag.move(y, this._gestureSensitivity, this._gestureAcceleration)
            : this._drag.move(x, rtl, this._gestureSensitivity, this._gestureAcceleration, this._gestureNaturalDirection);
        this._updateCount++;
        this._lastInput = [x, y];
        if (this._debugProgress && this._updateCount === 1)
            console.log(`${LOG} first update; mode=${this._mode}; kind=${this._kind}; x=${x}; y=${y}; progress=${progress}`);
        if (overview && this._drag.presented && !this._grab)
            this._capture();
        this._refreshProgressLabel();
    }

    _onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._stop(false);
        } else if (this._mode === 'stream') {
            // Movement arrives from Solaar, not as pointer events. While the
            // held button is diverted, any other click cancels.
            if (type === Clutter.EventType.BUTTON_PRESS)
                this._stop(false);
        } else if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === 1 && this._pressX === null)
                [this._pressX, this._pressY] = event.get_coords();
            else if (event.get_button() !== 1)
                this._stop(false);
        } else if (type === Clutter.EventType.MOTION && this._pressX !== null) {
            const [x, y] = event.get_coords();
            this._move(x - this._pressX, y - this._pressY);
        } else if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1 && this._pressX !== null) {
            const [x, y] = event.get_coords();
            this._move(x - this._pressX, y - this._pressY);
            this._stop(true);
        }
        return Clutter.EVENT_STOP;
    }

    // fromTracker is true when the stop came from the button hold itself
    // (release, cancel); otherwise GNOME ended it and the tracker must ignore
    // the rest of the hold.
    _stop(commit, fromTracker = false) {
        const wasStream = this._mode === 'stream';
        const releaseHold = commit && wasStream && this._drag !== null;
        if (wasStream && !fromTracker)
            this._tracker?.abandon();
        if (this._eventSignal) {
            global.stage.disconnect(this._eventSignal);
            this._eventSignal = 0;
        }
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        this._label?.destroy();
        this._label = null;
        // Our modal grab sits above the native swipe's grab: release in reverse.
        try {
            if (this._grab)
                Main.popModal(this._grab);
        } finally {
            this._grab = null;
            try {
                if (this._drag) {
                    if (this._debugProgress)
                        console.log(`${LOG} ${commit ? 'commit' : 'cancel'}; mode=${this._mode}; kind=${this._kind}; updates=${this._updateCount}; lastInput=${this._lastInput}; progress=${this._drag.progress}`);
                    this._drag.finish(commit, global.get_current_time());
                }
            } finally {
                this._drag = null;
                this._pressX = null;
                this._mode = null;
                this._kind = null;
                if (releaseHold) {
                    // A cosmetic pointer hold must never break a finished gesture.
                    try {
                        const [x, y] = global.get_pointer();
                        this._pointerHold.afterRelease(x, y, this._gestureReleaseDelay);
                    } catch (error) {
                        console.error(`${LOG} release hold unavailable: ${error.stack ?? error}`);
                    }
                } else {
                    this._pointerHold?.clear();
                }
            }
        }
    }
}

// Turns Solaar's Movement Stream (Started, Moved, Ended) into one GNOME
// gesture per button hold. No GI imports, so it can be tested outside GNOME.
//
// Movement arrives in counts at 1000 DPI. Until the hold has moved
// `threshold` counts it is undecided; then it locks to horizontal (workspace
// slide) or vertical (overview) and keeps that kind until the button is
// released. Updates are coalesced: each Moved only marks the hold dirty and
// asks for a flush, which the shell runs once per frame.

const IDLE = 'idle';
const PENDING = 'pending';
const IGNORED = 'ignored';      // a button we were told not to use
const REJECTED = 'rejected';    // GNOME declined or cancelled; wait for release
const ACTIVE = new Set(['horizontal', 'overview']);

export function buttonId(unitId, control) {
    return `${unitId}:${Number(control)}`;
}

export function classify(x, y, threshold, dominance = 1.25) {
    if (Math.max(Math.abs(x), Math.abs(y)) < threshold)
        return null;
    if (Math.abs(y) >= dominance * Math.abs(x))
        return 'overview';
    if (Math.abs(x) >= dominance * Math.abs(y))
        return 'horizontal';
    return null; // diagonal: keep accumulating until one axis wins
}

// At 1000 DPI one millimetre is 39.37 counts.
export const COUNTS_PER_MM = 1000 / 25.4;
const SPEED_WINDOW_MS = 50;

// Decides whether a hold was a flick: it got fast enough, never went
// backwards, and after its fastest moment never slowed below a share of
// that speed, right up to the release.
// Positions are summed counts along the gesture's axis; times are ms.
export class FlickDetector {
    constructor(startTime = 0) {
        this.reset(startTime);
    }

    // startTime: when the button was pressed, the origin before any movement.
    reset(startTime = 0) {
        this._startTime = startTime;
        this._samples = [];
        this._speeds = []; // signed counts/ms over the window ending at each sample
        this._back = -1;   // last sample at least one window before the newest
    }

    // Signed speed in counts/ms from the last sample at least a window
    // before `time` (or the press) to `position` at `time`. Moves `back`
    // forward as time goes on; returns [speed, back].
    _speed(time, position, back) {
        while (back + 1 < this._samples.length && this._samples[back + 1].time <= time - SPEED_WINDOW_MS)
            back++;
        const base = back < 0 ? {time: this._startTime, position: 0} : this._samples[back];
        // At least a full window: the first report often arrives right after
        // the press, and dividing by that tiny gap would look like a spike.
        return [(position - base.position) / Math.max(time - base.time, SPEED_WINDOW_MS), back];
    }

    add(time, position) {
        const [speed, back] = this._speed(time, position, this._back);
        this._back = back;
        this._samples.push({time, position});
        this._speeds.push(speed);
    }

    // {flick, peak, release, backtrack}: speeds in mm/s, backtrack in counts.
    judge(releaseTime, {minSpeed, keepRatio}) {
        const last = this._samples.at(-1);
        const result = {flick: false, peak: 0, release: 0, backtrack: 0};
        if (!last || last.position === 0)
            return result;
        const direction = Math.sign(last.position);

        let furthest = 0;
        for (const {position} of this._samples) {
            furthest = Math.max(furthest, direction * position);
            result.backtrack = Math.max(result.backtrack, furthest - direction * position);
        }

        // A pause before letting go shows up as a slow release speed.
        const [releaseSpeed] = this._speed(releaseTime, last.position, this._back);
        const speeds = [...this._speeds, releaseSpeed].map(v => direction * v);
        let peakIndex = 0;
        speeds.forEach((speed, i) => {
            if (speed > speeds[peakIndex])
                peakIndex = i;
        });
        const peak = speeds[peakIndex];
        let slowest = Infinity;
        for (let i = peakIndex; i < speeds.length; i++)
            slowest = Math.min(slowest, speeds[i]);

        const toMmPerSecond = speed => speed * 1000 / COUNTS_PER_MM;
        result.peak = toMmPerSecond(peak);
        result.release = toMmPerSecond(speeds.at(-1));
        // A little jitter backwards is not a change of direction.
        const tolerance = Math.max(6, 0.05 * furthest);
        result.flick = result.peak >= minSpeed && result.backtrack <= tolerance &&
            slowest >= keepRatio * peak;
        return result;
    }
}

export class GestureTracker {
    constructor({begin, update, end, accepts = () => true, requestFlush = () => {}, threshold = 8,
        now = () => Date.now()}) {
        if (!(threshold > 0))
            throw new Error('Direction threshold must be positive');
        this._begin = begin;
        this._update = update;
        this._end = end;
        this._accepts = accepts;
        this._requestFlush = requestFlush;
        this._now = now;
        this.threshold = threshold;
        // Experimental: {enabled, minSpeed (mm/s), keepRatio (0..1)}
        this.flick = {enabled: false, minSpeed: 150, keepRatio: 0.5};
        this.lastFlick = null; // the last judgement, for logs
        this._flickX = new FlickDetector();
        this._flickY = new FlickDetector();
        this._clear();
    }

    get state() {
        return this._state;
    }

    get unitId() {
        return this._unitId;
    }

    get active() {
        return ACTIVE.has(this._state);
    }

    started(unitId, control) {
        if (this._state !== IDLE && this._unitId !== unitId)
            return; // another device is mid-hold; one gesture at a time
        // A second Started from the same device means we missed its Ended.
        this._cancelActive();
        this._pressTime = this._now();
        this._clear();
        this._unitId = unitId;
        this._control = Number(control);
        this._state = this._accepts(unitId, this._control) ? PENDING : IGNORED;
    }

    moved(unitId, dx, dy) {
        if (unitId !== this._unitId || !(this._state === PENDING || this.active))
            return;
        if (!Number.isFinite(dx) || !Number.isFinite(dy))
            return;
        this.x += dx;
        this.y += dy;
        const time = this._now();
        this._flickX.add(time, this.x);
        this._flickY.add(time, this.y);
        if (this._state === PENDING) {
            const kind = classify(this.x, this.y, this.threshold);
            if (!kind)
                return;
            this._state = this._begin(kind) ? kind : REJECTED;
            if (!this.active)
                return;
        }
        if (!this._dirty) {
            this._dirty = true;
            this._requestFlush();
        }
    }

    flush() {
        if (!this.active || !this._dirty)
            return;
        this._dirty = false;
        if (!this._update(this.x, this.y))
            this._state = REJECTED; // Escape, timeout, lock: ignore the rest of this hold
    }

    ended(unitId, cancelled) {
        if (unitId !== this._unitId)
            return;
        try {
            if (!cancelled)
                this.flush();
            if (this.active) {
                let flick = false;
                if (!cancelled && this.flick.enabled) {
                    const detector = this._state === 'overview' ? this._flickY : this._flickX;
                    this.lastFlick = detector.judge(this._now(), this.flick);
                    flick = this.lastFlick.flick;
                }
                this._end(!cancelled, {flick});
            }
        } finally {
            this._clear();
        }
    }

    // GNOME stopped the gesture on its own (Escape, lock, monitors changed).
    // The button is still held, so stay out of the way until it is released.
    abandon() {
        if (this._state !== IDLE)
            this._state = REJECTED;
        this._dirty = false;
    }

    // Solaar went away or the extension is being disabled.
    reset() {
        try {
            this._cancelActive();
        } finally {
            this._clear();
        }
    }

    _cancelActive() {
        if (this.active) {
            this._state = REJECTED;
            this._end(false);
        }
    }

    _clear() {
        this._state = IDLE;
        this._unitId = null;
        this._control = null;
        this.x = 0;
        this.y = 0;
        this._dirty = false;
        this._flickX.reset(this._pressTime);
        this._flickY.reset(this._pressTime);
    }
}

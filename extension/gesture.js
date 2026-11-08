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

export class GestureTracker {
    constructor({begin, update, end, accepts = () => true, requestFlush = () => {}, threshold = 8}) {
        if (!(threshold > 0))
            throw new Error('Direction threshold must be positive');
        this._begin = begin;
        this._update = update;
        this._end = end;
        this._accepts = accepts;
        this._requestFlush = requestFlush;
        this.threshold = threshold;
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
            if (this.active)
                this._end(!cancelled);
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
    }
}

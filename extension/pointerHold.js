// GNOME's native barriers use integer coordinates. A one-pixel enclosure holds
// the shared pointer without a modal input grab or repeated pointer warps.
export function enclosure(x, y) {
    if (![x, y].every(Number.isFinite))
        throw new Error('Invalid pointer coordinates');
    const left = Math.max(0, Math.min(32766, Math.floor(x)));
    const top = Math.max(0, Math.min(32766, Math.floor(y)));
    const right = left + 1;
    const bottom = top + 1;
    return [
        {x1: left, y1: top, x2: left, y2: bottom, direction: 'POSITIVE_X'},
        {x1: right, y1: top, x2: right, y2: bottom, direction: 'NEGATIVE_X'},
        {x1: left, y1: top, x2: right, y2: top, direction: 'POSITIVE_Y'},
        {x1: left, y1: bottom, x2: right, y2: bottom, direction: 'NEGATIVE_Y'},
    ];
}

export class PointerHold {
    constructor({createBarrier, schedule, cancelTimer}) {
        this._createBarrier = createBarrier;
        this._schedule = schedule;
        this._cancelTimer = cancelTimer;
        this._barriers = [];
        this._timer = null;
        this._generation = 0;
    }

    afterRelease(x, y, milliseconds) {
        this.clear();
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2000)
            throw new Error('Invalid pointer release delay');
        // Off must bypass even barrier construction. This API intentionally has
        // no begin/release split: confinement belongs only after button release.
        if (milliseconds === 0)
            return;
        try {
            for (const boundary of enclosure(x, y))
                this._barriers.push(this._createBarrier(boundary));
            this._expireAfter(milliseconds);
        } catch (error) {
            this.clear();
            throw error;
        }
    }

    _expireAfter(milliseconds) {
        if (this._timer !== null)
            this._cancelTimer(this._timer);
        const generation = ++this._generation;
        this._timer = this._schedule(milliseconds, () => {
            if (generation !== this._generation)
                return;
            this._timer = null;
            this.clear();
        });
    }

    clear() {
        ++this._generation;
        if (this._timer !== null) {
            this._cancelTimer(this._timer);
            this._timer = null;
        }
        const barriers = this._barriers;
        this._barriers = [];
        let failure;
        for (const barrier of barriers) {
            try {
                barrier.destroy();
            } catch (error) {
                failure ??= error;
            }
        }
        if (failure)
            throw failure;
    }
}

// A position-based curve: independent of report frequency, reversible, and
// deliberately without inertia. One normalized unit is one native swipe span.
export function acceleratedOffset(delta, distance, sensitivity = 1, acceleration = 0) {
    if (![delta, distance, sensitivity, acceleration].every(Number.isFinite) ||
        distance <= 0 || sensitivity <= 0 || acceleration < 0 || acceleration > 3)
        throw new Error('Invalid gesture distance, sensitivity or acceleration');
    const linear = delta * sensitivity / distance;
    return linear * (1 + acceleration * Math.min(Math.abs(linear), 1));
}

// Where a released gesture settles. `start` and the result are whole steps
// (workspaces, or hidden/overview/app grid). Each step passed counts in full;
// the last partial step counts once it reaches `threshold` (0..1).
// A flick goes at least one step in `direction` (the way the hand moved,
// -1 or 1), which can differ from where progress is if the gesture took
// over a settle animation that had not finished.
export function settleTarget(start, progress, {threshold = 0.5, flick = false, direction} = {}) {
    if (![start, progress, threshold].every(Number.isFinite) || threshold <= 0 || threshold >= 1)
        throw new Error('Invalid settle position or threshold');
    const EPSILON = 1e-9;
    const delta = progress - start;
    const distance = Math.abs(delta);
    direction = Math.sign(direction ?? (distance < EPSILON ? 0 : delta));
    if (flick && direction !== 0) {
        if (Math.sign(delta) === direction)
            return start + direction * Math.max(1, Math.ceil(distance - EPSILON));
        return start + direction;
    }
    if (distance < EPSILON)
        return start;
    const whole = Math.floor(distance + EPSILON);
    const rest = distance - whole;
    const extra = rest > EPSILON && rest >= threshold - EPSILON ? 1 : 0;
    return start + Math.sign(delta) * (whole + extra);
}

// GNOME 50's SwipeTracker end duration (ui/swipeTracker.js), so a mouse
// glide settles like a touchpad swipe. Velocity is in progress per ms.
// GNOME's ease() makes this instant when animations are off.
const MIN_ANIMATION_DURATION = 100;
const MAX_ANIMATION_DURATION = 400;
const DURATION_MULTIPLIER = 3;
const ANIMATION_BASE_VELOCITY = 0.002;

export function settleDuration(progress, endProgress, velocity = 0) {
    const remaining = endProgress - progress;
    if (!Number.isFinite(remaining) || Math.abs(remaining) < 1e-9)
        return 0;
    if (!Number.isFinite(velocity) || remaining * velocity <= 0)
        velocity = ANIMATION_BASE_VELOCITY; // stopped, or moving the other way
    const nPoints = Math.max(1, Math.ceil(Math.abs(remaining)));
    const maxDuration = MAX_ANIMATION_DURATION * Math.log2(1 + nPoints);
    const duration = Math.abs(remaining / velocity * DURATION_MULTIPLIER);
    return Math.min(maxDuration, Math.max(MIN_ANIMATION_DURATION, duration));
}

// Progress per ms over the `window` ms before `now`, from {time, progress}
// samples in time order. A pause before `now` reads as slow.
export function recentVelocity(samples, now, window = 50) {
    if (samples.length === 0)
        return 0;
    const at = time => {
        let value = samples[0].progress;
        for (const sample of samples) {
            if (sample.time > time)
                break;
            value = sample.progress;
        }
        return value;
    };
    const from = Math.max(now - window, samples[0].time);
    if (now - from < 1)
        return 0;
    return (at(now) - at(from)) / (now - from);
}

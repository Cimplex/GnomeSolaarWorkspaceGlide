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
// the last partial step counts once it reaches `threshold` (0..1), or at all
// for a flick.
export function settleTarget(start, progress, {threshold = 0.5, flick = false} = {}) {
    if (![start, progress, threshold].every(Number.isFinite) || threshold <= 0 || threshold >= 1)
        throw new Error('Invalid settle position or threshold');
    const delta = progress - start;
    const distance = Math.abs(delta);
    const EPSILON = 1e-9;
    if (distance < EPSILON)
        return start;
    const whole = Math.floor(distance + EPSILON);
    const rest = distance - whole;
    const extra = rest > EPSILON && (flick || rest >= threshold - EPSILON) ? 1 : 0;
    return start + Math.sign(delta) * (whole + extra);
}

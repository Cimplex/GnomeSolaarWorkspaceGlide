// A position-based curve: independent of report frequency, reversible, and
// deliberately without inertia. One normalized unit is one native swipe span.
export function acceleratedOffset(delta, distance, sensitivity = 1, acceleration = 0) {
    if (![delta, distance, sensitivity, acceleration].every(Number.isFinite) ||
        distance <= 0 || sensitivity <= 0 || acceleration < 0 || acceleration > 3)
        throw new Error('Invalid gesture distance, sensitivity or acceleration');
    const linear = delta * sensitivity / distance;
    return linear * (1 + acceleration * Math.min(Math.abs(linear), 1));
}

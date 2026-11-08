// Adapter for GNOME Shell 50's WorkspaceAnimationController.
// No GI imports: the lifecycle can also be exercised outside GNOME Shell.
import {acceleratedOffset, settleTarget} from './motion.js';

export class NativeDrag {
    constructor(controller, monitorIndex) {
        this.controller = controller;
        this.data = null;
        this.previousEnabled = controller._swipeTracker.enabled;
        // A swipe that is still settling (ours or the touchpad's) can be taken
        // over, as GNOME does for touchpad swipes; any other transition cannot.
        if (controller._switchData && !controller._switchData.gestureActivated)
            throw new Error('GNOME already has a workspace transition in progress');

        // Where a settle we are taking over was heading: a second flick
        // carries on from there rather than from the nearest workspace.
        const heading = controller._switchData?.workspaceGlideSettle?.end;

        controller._swipeTracker.enabled = false;
        try {
            controller._switchWorkspaceBegin({
                confirmSwipe: (distance, points, progress, cancelProgress) => {
                    this.distance = distance;
                    this.points = points;
                    this.start = progress;
                    this.progress = progress;
                    // The workspace to settle around: where a settle that was
                    // taken over was heading, otherwise the nearest one.
                    this.base = Number.isFinite(heading) ? heading
                        : Number.isFinite(cancelProgress) ? cancelProgress : progress;
                },
            }, monitorIndex);
            this.data = controller._switchData;
            if (!this.data || !Number.isFinite(this.distance) || this.distance <= 0)
                throw new Error('GNOME did not prepare the workspace swipe');

            // Suppress an additional workspace animation when committing.
            // The native touchpad end handler sets this same flag.
            this.data.gestureActivated = true;
            // A settle we took over must not finish this gesture's switch.
            this.data.workspaceGlideSettle = null;
        } catch (error) {
            // Partial setup is ours (or was a settle we were taking over).
            this.data = controller._switchData;
            this.finish(false, 0);
            throw error;
        }
    }

    move(deltaX, rtl = false, sensitivity = 1, acceleration = 0, natural = false) {
        const directedX = natural ? -deltaX : deltaX;
        const offset = acceleratedOffset(rtl ? directedX : -directedX, this.distance, sensitivity, acceleration);
        if (!this.data || this.controller._switchData !== this.data)
            throw new Error('GNOME ended the workspace swipe');

        const minimum = Math.max(this.points[0], this.start - 1);
        const maximum = Math.min(this.points.at(-1), this.start + 1);
        this.progress = Math.min(maximum, Math.max(minimum, this.start + offset));
        // This assigns MonitorGroup.progress directly. No ease(), duration,
        // slow_down_factor or enable-animations setting is involved.
        this.controller._switchWorkspaceUpdate(null, this.progress);
        return this.progress;
    }

    // settle: {threshold, flick} for settleTarget, plus how to animate:
    //   duration(progress, endProgress) → ms; 0 or absent snaps at once
    //   mode: the Clutter animation mode
    // timestamp: a number, or a function called when the workspace activates.
    finish(commit, timestamp, settle = {}) {
        const time = () => typeof timestamp === 'function' ? timestamp() : timestamp;
        let animating = false;
        try {
            if (!this.data || this.controller._switchData !== this.data)
                return;
            try {
                if (commit) {
                    const direction = Math.sign(this.progress - this.start);
                    const end = Math.min(this.points.at(-1), Math.max(this.points[0],
                        settleTarget(this.base, this.progress, {...settle, direction})));
                    const target = this.data.baseMonitorGroup.findClosestWorkspace(end);
                    const duration = settle.duration?.(this.progress, end) ?? 0;
                    if (duration > 0) {
                        this._ease(target, end, duration, settle.mode, time);
                        animating = true;
                    } else {
                        // Instant release snap, as with animations off.
                        for (const group of this.data.monitors)
                            group.progress = group.getWorkspaceProgress(target);
                        if (!target.active)
                            target.activate(time());
                    }
                }
            } finally {
                if (!animating)
                    this.controller._finishWorkspaceSwitch(this.data);
            }
        } finally {
            this.data = null;
            this.controller._swipeTracker.enabled = this.previousEnabled;
        }
    }

    // GNOME's touchpad release (_switchWorkspaceEnd) with our own timestamp.
    // If a new swipe takes over first, GNOME removes these transitions and
    // onComplete does not run; that swipe finishes the switch instead.
    _ease(target, end, duration, mode, time) {
        const {controller, data} = this;
        const token = {end};
        data.workspaceGlideSettle = token;
        for (const group of data.monitors) {
            const params = {duration, mode};
            if (group === data.baseMonitorGroup) {
                params.onComplete = () => {
                    if (controller._switchData !== data || data.workspaceGlideSettle !== token)
                        return; // taken over or already finished
                    data.workspaceGlideSettle = null;
                    try {
                        if (!target.active)
                            target.activate(time());
                    } finally {
                        controller._finishWorkspaceSwitch(data);
                    }
                };
            }
            group.ease_property('progress', group.getWorkspaceProgress(target), params);
        }
    }
}

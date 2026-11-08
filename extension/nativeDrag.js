// Adapter for GNOME Shell 50's WorkspaceAnimationController.
// No GI imports: the lifecycle can also be exercised outside GNOME Shell.
import {acceleratedOffset} from './motion.js';

export class NativeDrag {
    constructor(controller, monitorIndex) {
        this.controller = controller;
        this.data = null;
        this.previousEnabled = controller._swipeTracker.enabled;
        if (controller._switchData)
            throw new Error('GNOME already has a workspace transition in progress');

        controller._swipeTracker.enabled = false;
        try {
            controller._switchWorkspaceBegin({
                confirmSwipe: (distance, points, progress) => {
                    this.distance = distance;
                    this.points = points;
                    this.start = progress;
                    this.progress = progress;
                },
            }, monitorIndex);
            this.data = controller._switchData;
            if (!this.data || !Number.isFinite(this.distance) || this.distance <= 0)
                throw new Error('GNOME did not prepare the workspace swipe');

            // Suppress an additional workspace animation when committing.
            // The native touchpad end handler sets this same flag.
            this.data.gestureActivated = true;
        } catch (error) {
            // No switch existed before our begin, so partial setup is ours.
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

    finish(commit, timestamp) {
        try {
            if (!this.data || this.controller._switchData !== this.data)
                return;
            try {
                if (commit) {
                    const target = this.data.baseMonitorGroup.findClosestWorkspace(this.progress);
                    // Instant release snap, appropriate for animations at 0x.
                    for (const group of this.data.monitors)
                        group.progress = group.getWorkspaceProgress(target);
                    if (!target.active)
                        target.activate(timestamp);
                }
            } finally {
                this.controller._finishWorkspaceSwitch(this.data);
            }
        } finally {
            this.data = null;
            this.controller._swipeTracker.enabled = this.previousEnabled;
        }
    }
}

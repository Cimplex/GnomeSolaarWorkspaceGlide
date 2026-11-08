import {acceleratedOffset} from './motion.js';

// Uses the same lifecycle as Overview's native touchpad swipe on GNOME 50.
// The outer Overview methods manage visibility/grabs/cover pane; controls alone
// are insufficient to make an initially hidden overview interactive afterward.
export class NativeOverviewDrag {
    constructor(overview) {
        this.overview = overview;
        this.controls = overview._overview.controls;
        const adjustment = this.controls._stateAdjustment;
        const tracker = overview._swipeTracker;
        // GNOME 50 SwipeTracker resets _state to NONE (0) before emitting end.
        // A downward touchpad swipe on an already-hidden overview can throw
        // HIDDEN -> HIDING before controls.gestureEnd clears gestureInProgress.
        // Recover only after the real tracker is idle and no animation remains;
        // a live native swipe must never be interrupted by our fake tracker.
        if (overview.animationInProgress || tracker._state === 1 ||
            adjustment.get_transition?.('value'))
            throw new Error('Overview has an active animation or native touchpad swipe');

        const staleGesture = adjustment.gestureInProgress && tracker._state === 0;
        const staleHiddenValue = !overview.visible && adjustment.value !== 0 && tracker._state === 0;
        if (staleGesture || staleHiddenValue) {
            const settled = overview.visible ? Math.round(adjustment.value) : 0;
            if (![0, 1, 2].includes(settled))
                throw new Error('Overview is showing the app grid');
            // Controls-only cleanup avoids repeating the invalid outer state
            // transition. It clears preparation and the stuck gesture flag.
            console.log(`[SolaarWorkspaceGlide] recovering idle overview; progress=${adjustment.value}; gesture=${adjustment.gestureInProgress}; settled=${settled}`);
            this.controls.gestureEnd(settled, 0, null);
        }
        if (adjustment.gestureInProgress || ![0, 1, 2].includes(adjustment.value))
            throw new Error(`Overview is busy or showing the app grid (progress=${adjustment.value}, nativeState=${tracker._state}, gesture=${adjustment.gestureInProgress})`);

        this.previousEnabled = overview._swipeTracker.enabled;
        this.active = true;
        this.presented = overview.visible;
        overview._swipeTracker.enabled = false;
        try {
            overview._gestureBegin({
                confirmSwipe: (distance, _points, progress) => {
                    this.distance = distance;
                    this.start = progress;
                    this.progress = progress;
                },
            });
            if (!Number.isFinite(this.distance) || this.distance <= 0)
                throw new Error('GNOME did not prepare the overview swipe');
        } catch (error) {
            // gestureBegin may have set the flag before failing.
            adjustment.gestureInProgress = false;
            overview._swipeTracker.enabled = this.previousEnabled;
            this.active = false;
            throw error;
        }
    }

    move(deltaY, sensitivity = 1, acceleration = 0) {
        if (!this.active)
            throw new Error('Overview swipe has ended');
        const offset = acceleratedOffset(-deltaY, this.distance, sensitivity, acceleration);
        // Upward movement past the window overview is held there: the app
        // grid is not part of this gesture.
        this.progress = Math.max(0, Math.min(Math.max(1, this.start), this.start + offset));
        if (this.progress > 0) {
            // Mark first: showing is emitted synchronously during this call.
            this.presented = true;
            this.overview._gestureUpdate(null, this.progress);
        } else if (this.presented) {
            // GNOME's outer update deliberately skips exact zero. Once shown,
            // the controls still need zero when reversing back to the desktop.
            this.controls.gestureProgress(0);
        }
        return this.progress;
    }

    finish(commit) {
        if (!this.active)
            return;
        this.active = false;
        const target = commit ? Math.round(this.progress) : this.start;
        try {
            if (this.presented) {
                // Native completion manages shown/hidden state and its modal
                // grab. Duration zero preserves the user's 0x release behavior.
                this.overview._gestureEnd(null, 0, target);
            } else {
                // No positive progress: overview never emitted showing. Calling
                // the outer end would request an illegal HIDDEN -> HIDING state.
                this.controls.gestureEnd(0, 0, null);
            }
        } finally {
            this.overview._swipeTracker.enabled = this.previousEnabled;
        }
    }
}

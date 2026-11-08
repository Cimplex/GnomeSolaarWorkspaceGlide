import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buttonId} from './gesture.js';
import {MovementStream} from './movementStream.js';
import {MODE, cacheFromProbe, mergeButtons, modeLabel} from './solaarDiscovery.js';
import {locateSolaar, probeSolaar, setMovementStream} from './solaarTools.js';
import {BUS_INTERFACE, BUS_PATH} from './testService.js';

const README_URL = 'https://github.com/Cimplex/GnomeSolaarWorkspaceGlide#readme';
const FORK_URL = 'https://github.com/Cimplex/GnomeSolaarWorkspaceGlide#1-install-solaar-with-movement-stream';

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (_error) {
        return fallback;
    }
}

function statusIcon(ok) {
    return new Gtk.Image({
        icon_name: ok ? 'object-select-symbolic' : 'dialog-warning-symbolic',
        css_classes: [ok ? 'success' : 'warning'],
        valign: Gtk.Align.CENTER,
    });
}

function newSpinner() {
    return Adw.Spinner ? new Adw.Spinner({visible: false}) : new Gtk.Spinner({visible: false, spinning: true});
}

// Everything the Buttons page shows, refreshed when Solaar or the settings change.
class ButtonsPage {
    constructor(window, settings, probePath) {
        this._window = window;
        this._settings = settings;
        this._probePath = probePath;
        this._solaar = null;
        this._probe = {};
        this._deviceGroups = [];
        this._busy = new Set();
        this._scan = 0;
        this._destroyed = false;

        this.page = new Adw.PreferencesPage({title: 'Buttons', icon_name: 'input-mouse-symbolic'});
        this._buildStatus();
        this._buildChoice();
        this._signals = [
            settings.connect('changed::seen-buttons', () => this._render()),
            settings.connect('changed::selected-buttons', () => this._render()),
            settings.connect('changed::listen-all-buttons', () => this._render()),
        ];
        this._stream = new MovementStream({
            onStarted: (unitId, control) => this._live(unitId, control, 'held'),
            onMoved: (unitId, dx, dy) => this._moved(unitId, dx, dy),
            onEnded: (unitId, cancelled) => this._live(unitId, null, cancelled ? 'cancelled' : 'released'),
            onSolaar: () => this.refresh(), // also called once at start, which runs the first scan
        });
        this._render();
    }

    _buildStatus() {
        const group = new Adw.PreferencesGroup({
            title: 'Solaar',
            description: 'Solaar sends button movement to this extension while you hold a button set to Movement Stream.',
        });
        this.page.add(group);
        this._solaarRow = new Adw.ActionRow({title: 'Solaar', subtitle: 'Looking for Solaar…', use_markup: false});
        this._supportRow = new Adw.ActionRow({title: 'Movement Stream', subtitle: 'Checking…', use_markup: false});
        this._liveRow = new Adw.ActionRow({
            title: 'Live check',
            subtitle: 'Hold a button that is set to Movement Stream and move the mouse.',
            use_markup: false,
        });
        this._liveIcon = new Gtk.Image({icon_name: 'input-mouse-symbolic', valign: Gtk.Align.CENTER, opacity: 0.5});
        this._liveRow.add_suffix(this._liveIcon);
        for (const row of [this._solaarRow, this._supportRow, this._liveRow])
            group.add(row);
        this._solaarIcon = null;
        this._supportIcon = null;
        this._forkButton = new Gtk.Button({label: 'How to install', valign: Gtk.Align.CENTER, visible: false});
        this._forkButton.connect('clicked', () => new Gtk.UriLauncher({uri: FORK_URL}).launch(this._window, null, null));
        this._supportRow.add_suffix(this._forkButton);
    }

    _buildChoice() {
        this._choiceGroup = new Adw.PreferencesGroup({
            title: 'Buttons',
            description: 'Buttons Solaar can stream. A button glides only when it is set to Movement Stream in Solaar.',
        });
        const suffix = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        this._spinner = newSpinner();
        this._refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic', tooltip_text: 'Ask Solaar again', css_classes: ['flat'],
        });
        this._refreshButton.connect('clicked', () => this.refresh());
        suffix.append(this._spinner);
        suffix.append(this._refreshButton);
        this._choiceGroup.set_header_suffix(suffix);
        this.page.add(this._choiceGroup);

        this._allRow = new Adw.SwitchRow({
            title: 'Glide with every streaming button',
            subtitle: 'Turn off to choose buttons below.',
        });
        this._settings.bind('listen-all-buttons', this._allRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._allRow.connect('notify::active', () => {
            if (!this._allRow.active)
                this._seedSelection();
        });
        this._choiceGroup.add(this._allRow);
        this._emptyRow = new Adw.ActionRow({
            title: 'No streamable buttons found',
            subtitle: 'Connect your mouse, then press the refresh button above.',
            use_markup: false,
        });
        this._choiceGroup.add(this._emptyRow);
    }

    // Turning "every button" off should not silently stop all gliding:
    // start from the buttons that are streaming already.
    _seedSelection() {
        if (this._settings.get_strv('selected-buttons').length > 0)
            return;
        const ids = [];
        for (const device of this._devices ?? []) {
            for (const button of device.buttons) {
                if (button.mode === MODE.MOVEMENT_STREAM || button.seen)
                    ids.push(buttonId(device.unitId, button.control));
            }
        }
        this._settings.set_strv('selected-buttons', ids);
    }

    async refresh() {
        const scan = ++this._scan;
        this._setScanning(true);
        try {
            this._solaar = await locateSolaar();
            if (this._stale(scan))
                return;
            this._showSolaar();
            if (!this._solaar?.script) {
                this._probe = {};
                this._render();
                return;
            }
            // Saved configuration first (fast), then the connected devices.
            this._probe = await probeSolaar(this._solaar, this._probePath, {live: false});
            if (this._stale(scan))
                return;
            this._showSolaar();
            this._render();
            const live = await probeSolaar(this._solaar, this._probePath, {live: true});
            if (this._stale(scan))
                return;
            this._probe = live;
            const cache = parseJson(this._settings.get_string('known-devices'), []);
            this._settings.set_string('known-devices', JSON.stringify(cacheFromProbe(live, cache)));
            this._showSolaar();
            this._render();
        } catch (error) {
            if (this._stale(scan))
                return;
            console.error(`[SolaarWorkspaceGlide] prefs scan: ${error.stack ?? error}`);
            this._toast(`Could not ask Solaar: ${error.message}`);
            this._render();
        } finally {
            if (!this._stale(scan))
                this._setScanning(false);
        }
    }

    _stale(scan) {
        return this._destroyed || scan !== this._scan;
    }

    _setScanning(scanning) {
        this._spinner.visible = scanning;
        this._refreshButton.sensitive = !scanning;
    }

    _setIcon(row, field, ok) {
        if (this[field])
            row.remove(this[field]);
        this[field] = statusIcon(ok);
        row.add_suffix(this[field]);
    }

    _showSolaar() {
        const solaar = this._solaar;
        const probe = this._probe ?? {};
        const version = probe.version ? ` ${probe.version}` : '';
        if (!solaar) {
            this._solaarRow.subtitle = 'Solaar is not installed or not on your PATH.';
        } else if (!solaar.running) {
            this._solaarRow.subtitle = `Solaar${version} is installed (${solaar.script}) but not running. Start it to glide.`;
        } else {
            this._solaarRow.subtitle = solaar.script
                ? `Solaar${version} is running from ${solaar.script}`
                : 'Solaar is running, but its program could not be found to ask about buttons.';
        }
        this._setIcon(this._solaarRow, '_solaarIcon', Boolean(solaar?.running));

        let supported = null;
        if (probe.version) {
            supported = Boolean(probe.patched);
            this._supportRow.subtitle = supported
                ? 'This Solaar supports Movement Stream.'
                : 'This Solaar does not have Movement Stream yet. Install the Solaar fork.';
        } else if (this._stream.solaarPresent && this._sawStream) {
            supported = true;
            this._supportRow.subtitle = 'Solaar is sending Movement Stream signals.';
        } else {
            this._supportRow.subtitle = solaar ? 'Checking…' : 'Needs a Solaar with Movement Stream.';
        }
        this._forkButton.visible = supported === false || !solaar;
        this._setIcon(this._supportRow, '_supportIcon', supported !== false && Boolean(solaar));
    }

    _render() {
        if (this._destroyed)
            return;
        const cache = parseJson(this._settings.get_string('known-devices'), []);
        const seen = this._settings.get_strv('seen-buttons');
        this._devices = mergeButtons({probe: this._probe, cache, seen});
        const listenAll = this._settings.get_boolean('listen-all-buttons');
        const selected = new Set(this._settings.get_strv('selected-buttons'));

        for (const group of this._deviceGroups)
            this.page.remove(group);
        this._deviceGroups = [];
        this._emptyRow.visible = this._devices.length === 0;

        for (const device of this._devices) {
            const group = new Adw.PreferencesGroup({
                title: GLib.markup_escape_text(device.name, -1),
                description: device.online ? 'Connected' : 'Not connected',
            });
            for (const button of device.buttons)
                group.add(this._buttonRow(device, button, listenAll, selected));
            this.page.add(group);
            this._deviceGroups.push(group);
        }
    }

    _buttonRow(device, button, listenAll, selected) {
        const id = buttonId(device.unitId, button.control);
        const row = new Adw.ActionRow({title: button.name, subtitle: this._describe(device, button), use_markup: false});

        if (button.streamable && button.mode !== MODE.MOVEMENT_STREAM && device.online && button.streamChoice) {
            const set = new Gtk.Button({
                label: 'Use Movement Stream', valign: Gtk.Align.CENTER, sensitive: !this._busy.has(id),
                tooltip_text: `Set ${button.name} to Movement Stream in Solaar`,
            });
            set.connect('clicked', () => this._useMovementStream(device, button, id));
            row.add_suffix(set);
        }

        if (listenAll)
            return row;
        const glide = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: selected.has(id),
            tooltip_text: 'Glide with this button',
        });
        glide.connect('notify::active', () => {
            const ids = new Set(this._settings.get_strv('selected-buttons'));
            if (glide.active)
                ids.add(id);
            else
                ids.delete(id);
            this._settings.set_strv('selected-buttons', [...ids]);
        });
        row.add_suffix(glide);
        row.activatable_widget = glide;
        return row;
    }

    _describe(device, button) {
        const parts = [];
        if (button.streamable === false) {
            parts.push('Can stream once Solaar has Movement Stream');
        } else if (button.mode === MODE.MOVEMENT_STREAM) {
            parts.push('Set to Movement Stream in Solaar');
        } else if (button.streamable === null && !device.online) {
            parts.push(button.mode === null ? 'Connect the device to check this button' : `Set to ${modeLabel(button.mode)} in Solaar`);
        } else {
            parts.push(`Set to ${modeLabel(button.mode ?? MODE.REGULAR)} in Solaar`);
        }
        if (button.seen)
            parts.push('has streamed');
        if (this._liveId === buttonId(device.unitId, button.control))
            parts.push('held now');
        return parts.join(' · ');
    }

    async _useMovementStream(device, button, id) {
        this._busy.add(id);
        this._render();
        try {
            await setMovementStream(this._solaar, device, button.control, button.streamChoice);
            this._toast(`${button.name} now uses Movement Stream`);
            // The running Solaar saves the change on its own main loop.
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            if (this._destroyed)
                return;
            this._probe = await probeSolaar(this._solaar, this._probePath, {live: false})
                .then(saved => ({...saved, live: this._probe.live}));
        } catch (error) {
            this._toast(`Could not change ${button.name}: ${error.message}`);
        } finally {
            this._busy.delete(id);
            this._render();
        }
    }

    _nameOf(unitId, control) {
        const device = this._devices?.find(d => d.unitId === unitId);
        const button = device?.buttons.find(b => b.control === Number(control));
        return {
            device: device?.name ?? unitId,
            button: button?.name ?? `control ${control}`,
        };
    }

    _live(unitId, control, state) {
        this._sawStream = true;
        if (state === 'held') {
            this._liveId = buttonId(unitId, control);
            this._liveTotal = [0, 0];
        }
        const [, controlId] = (this._liveId ?? ':').split(':');
        const {device, button} = this._nameOf(unitId, control ?? controlId);
        const glides = this._settings.get_boolean('listen-all-buttons') ||
            this._settings.get_strv('selected-buttons').includes(this._liveId);
        if (state === 'held') {
            this._liveRow.subtitle = `${button} on ${device} is held${glides ? '' : ' (not selected to glide)'}`;
            this._liveIcon.opacity = 1;
        } else {
            this._liveRow.subtitle = `${button} on ${device} was ${state} · Movement Stream works`;
            this._liveIcon.opacity = 0.5;
            this._liveId = null;
        }
        this._showSolaar();
        this._render();
    }

    _moved(unitId, dx, dy) {
        if (!this._liveId?.startsWith(`${unitId}:`))
            return;
        this._liveTotal[0] += dx;
        this._liveTotal[1] += dy;
        const [, control] = this._liveId.split(':');
        const {device, button} = this._nameOf(unitId, control);
        const [x, y] = this._liveTotal.map(v => Math.round(v));
        this._liveRow.subtitle = `${button} on ${device} is held · moved ${x}, ${y}`;
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 4}));
    }

    destroy() {
        this._destroyed = true;
        this._stream.destroy();
        for (const id of this._signals)
            this._settings.disconnect(id);
        this._signals = [];
    }
}

export default class SolaarWorkspaceGlidePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 760);
        window.search_enabled = false;

        const buttons = new ButtonsPage(window, settings, GLib.build_filenamev([this.path, 'solaarProbe.py']));
        window.add(buttons.page);
        window.add(this._gesturesPage(window, settings));
        window.add(this._diagnosticsPage(window, settings));
        window.connect('close-request', () => {
            buttons.destroy();
            return false;
        });
    }

    _gesturesPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Gestures', icon_name: 'preferences-desktop-multitasking-symbolic'});
        const how = new Adw.PreferencesGroup({
            title: 'How it works',
            description: 'Hold the button and move left or right to slide between workspaces, or up to open the overview. ' +
                'Move down to leave the overview. Release to settle on the nearest workspace or view; press Escape to cancel.',
        });
        page.add(how);

        const motion = new Adw.PreferencesGroup({title: 'Movement', description: 'Changes apply to the next gesture.'});
        page.add(motion);
        this._spin(motion, settings, 'sensitivity', 'Sensitivity',
            'Distance multiplier. Higher values need less mouse movement.', 0.25, 12, 0.25, 2);
        this._spin(motion, settings, 'acceleration', 'Acceleration',
            '0 is Off · 0.5 Gentle · 1 Medium · 2 Strong', 0, 3, 0.25, 2);
        this._spin(motion, settings, 'direction-threshold', 'Dead zone',
            'How far to move, in counts at 1000 DPI, before the gesture picks sideways or up/down.', 2, 100, 1, 0);

        const direction = new Adw.ComboRow({
            title: 'Workspace direction',
            subtitle: 'Standard: the view follows the mouse. Natural: it moves the other way. The overview always opens upward.',
            model: Gtk.StringList.new(['Standard', 'Natural']),
            selected: settings.get_boolean('natural-workspace-direction') ? 1 : 0,
        });
        motion.add(direction);
        direction.connect('notify::selected', () => settings.set_boolean('natural-workspace-direction', direction.selected === 1));
        const directionSignal = settings.connect('changed::natural-workspace-direction', () => {
            direction.selected = settings.get_boolean('natural-workspace-direction') ? 1 : 0;
        });
        window.connect('close-request', () => {
            settings.disconnect(directionSignal);
            return false;
        });

        const release = new Adw.PreferencesGroup({title: 'After release'});
        page.add(release);
        this._spin(release, settings, 'release-deadtime-ms', 'Pointer release delay',
            'Milliseconds to keep the pointer still after letting go, so it does not jump. Affects every pointing device. 0 turns it off.',
            0, 2000, 50, 0);
        return page;
    }

    _diagnosticsPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Diagnostics', icon_name: 'applications-engineering-symbolic'});
        const display = new Adw.PreferencesGroup({title: 'Progress display'});
        page.add(display);
        const progress = new Adw.SwitchRow({
            title: 'Show gesture progress',
            subtitle: 'Show an on-screen progress badge and write detailed gesture logs to the journal.',
        });
        settings.bind('debug-progress', progress, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(progress);

        const tests = new Adw.PreferencesGroup({
            title: 'Test without Solaar',
            description: 'Check GNOME\'s side with an ordinary left-button drag. Starting a test hides this window; Escape cancels.',
        });
        page.add(tests);
        this._action(tests, 'Workspace drag test', 'Hold the left mouse button and drag left or right.',
            'Start test', () => this._startTest(window, 'horizontal'));
        this._action(tests, 'Overview drag test', 'Hold the left mouse button and drag up or down.',
            'Start test', () => this._startTest(window, 'overview'));

        const help = new Adw.PreferencesGroup({title: 'Help'});
        page.add(help);
        this._action(help, 'Setup guide', 'Installing the Solaar fork and setting up your mouse.', 'Open',
            () => new Gtk.UriLauncher({uri: README_URL}).launch(window, null, null));
        return page;
    }

    _spin(group, settings, key, title, subtitle, lower, upper, step, digits) {
        const row = new Adw.SpinRow({
            title, subtitle, digits,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }

    _action(group, title, subtitle, label, callback) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
        button.connect('clicked', callback);
        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
    }

    _startTest(window, kind) {
        window.set_visible(false);
        Gio.DBus.session.call('org.gnome.Shell', BUS_PATH, BUS_INTERFACE, 'StartTest', new GLib.Variant('(s)', [kind]),
            new GLib.VariantType('(b)'), Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
            (connection, result) => {
                try {
                    const [accepted] = connection.call_finish(result).deepUnpack();
                    if (accepted) {
                        window.close();
                        return;
                    }
                    window.present();
                    window.add_toast(new Adw.Toast({title: 'Close any overview or dialog, then try again.'}));
                } catch (_error) {
                    window.present();
                    window.add_toast(new Adw.Toast({title: 'Turn the extension on before starting a test.'}));
                }
            });
    }
}

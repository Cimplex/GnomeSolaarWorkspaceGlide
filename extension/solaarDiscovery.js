// Pure helpers for finding Solaar and making sense of what it reports.
// No GI imports, so the preferences logic can be tested outside GNOME.

export const PROBE_MARKER = '@@solaar-workspace-glide@@';

export const MODE = Object.freeze({
    REGULAR: 0, DIVERTED: 1, MOUSE_GESTURES: 2, SLIDING_DPI: 3, MOVEMENT_STREAM: 5,
});

const MODE_LABELS = new Map([
    [MODE.REGULAR, 'Regular'],
    [MODE.DIVERTED, 'Diverted'],
    [MODE.MOUSE_GESTURES, 'Mouse Gestures'],
    [MODE.SLIDING_DPI, 'Sliding DPI'],
    [MODE.MOVEMENT_STREAM, 'Movement Stream'],
]);

// Only buttons with raw XY are offered these choices, so a saved one proves
// the button can stream even when the device is not connected.
const RAW_XY_MODES = new Set([MODE.MOUSE_GESTURES, MODE.SLIDING_DPI, MODE.MOVEMENT_STREAM]);

export function modeLabel(mode) {
    return MODE_LABELS.get(mode) ?? (Number.isInteger(mode) ? `Mode ${mode}` : 'Unknown');
}

// Python options that take a separate argument, e.g. `python3 -X dev script`.
const PYTHON_OPTIONS_WITH_ARGUMENT = new Set(['-W', '-X', '-Q']);

function isPython(path) {
    return /(^|\/)python[0-9.]*$/.test(path ?? '');
}

// From a running process's argv, e.g. ['/usr/bin/python3', '-sP', '/usr/bin/solaar', '--window=hide'],
// find the interpreter, its options and the Solaar script. Returns null if it is not a Python Solaar.
export function parseCommandLine(argv) {
    if (!Array.isArray(argv) || argv.length === 0)
        return null;
    if (!isPython(argv[0]))
        return /(^|\/)solaar$/.test(argv[0]) ? {interpreter: null, options: [], script: argv[0]} : null;
    const options = [];
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-c' || arg === '-m' || arg === '-')
            return null; // not started from a script file
        if (!arg.startsWith('-'))
            return {interpreter: argv[0], options, script: arg};
        options.push(arg);
        if (PYTHON_OPTIONS_WITH_ARGUMENT.has(arg) && i + 1 < argv.length)
            options.push(argv[++i]);
    }
    return null;
}

// `#!/usr/bin/python3 -sP` → {interpreter: '/usr/bin/python3', options: ['-sP']}
// `#!/usr/bin/env python3` → {interpreter: 'python3', options: []}
export function parseShebang(firstLine) {
    const match = /^#!\s*(\S+)(.*)$/.exec(firstLine ?? '');
    if (!match)
        return null;
    let words = [match[1], ...match[2].trim().split(/\s+/).filter(Boolean)];
    if (/(^|\/)env$/.test(words[0])) {
        words = words.slice(1);
        if (words[0] === '-S')
            words = words.slice(1);
    }
    if (!isPython(words[0]))
        return null;
    return {interpreter: words[0], options: words.slice(1)};
}

export function parseProbeOutput(stdout) {
    const index = (stdout ?? '').lastIndexOf(PROBE_MARKER);
    if (index < 0)
        throw new Error('Solaar did not answer the probe');
    const json = stdout.slice(index + PROBE_MARKER.length).trim().split('\n')[0];
    const result = JSON.parse(json);
    if (typeof result !== 'object' || result === null)
        throw new Error('Solaar gave an unreadable answer');
    return result;
}

// Bring together everything known about buttons:
//   probe.live   devices connected right now, with Solaar's own streamable answer
//   probe.saved  Solaar's config.yaml, including disconnected devices and current modes
//   cache        devices from earlier live scans, so they stay listed when disconnected
//   seen         buttons that have sent a Movement Stream signal ("unit:control" ids)
// Returns devices sorted by name, each with buttons sorted by control id.
export function mergeButtons({probe = {}, cache = [], seen = []} = {}) {
    const devices = new Map();
    const device = (unitId, name, serial) => {
        unitId = String(unitId);
        if (!devices.has(unitId))
            devices.set(unitId, {unitId, serial: null, name: name || unitId, online: false, buttons: new Map()});
        const entry = devices.get(unitId);
        if (name && entry.name === unitId)
            entry.name = name;
        if (serial)
            entry.serial = String(serial);
        return entry;
    };
    const button = (entry, control, name) => {
        control = Number(control);
        if (!entry.buttons.has(control)) {
            entry.buttons.set(control, {
                control, name: name || `Control 0x${control.toString(16).toUpperCase().padStart(4, '0')}`,
                streamable: null, streamChoice: null, mode: null, seen: false,
            });
        } else if (name) {
            entry.buttons.get(control).name = name;
        }
        return entry.buttons.get(control);
    };

    for (const known of Array.isArray(cache) ? cache : []) {
        const entry = device(known.unitId, known.name, known.serial);
        for (const b of known.buttons ?? [])
            button(entry, b.control, b.name);
    }
    const live = new Set();
    for (const found of probe.live ?? []) {
        if (!found.online || !found.unitId)
            continue;
        live.add(String(found.unitId));
        const entry = device(found.unitId, found.name, found.serial);
        entry.online = true;
        entry.buttons.clear(); // a live answer replaces what the cache remembered
        for (const b of found.buttons ?? []) {
            const merged = button(entry, b.control, b.name);
            merged.streamable = Boolean(b.streamable);
            merged.streamChoice = b.streamable ? b.streamChoice ?? null : null;
        }
    }
    for (const saved of probe.saved ?? []) {
        const entry = device(saved.unitId, saved.name, saved.serial);
        for (const b of saved.buttons ?? []) {
            const known = entry.buttons.has(Number(b.control));
            if (!known && (live.has(entry.unitId) || !RAW_XY_MODES.has(b.mode)))
                continue; // not a raw-XY button
            const merged = button(entry, b.control, known ? null : b.name);
            merged.mode = b.mode;
            if (b.mode === MODE.MOVEMENT_STREAM && merged.streamable === null)
                merged.streamable = true;
        }
    }
    for (const id of seen) {
        const [unitId, control] = String(id).split(':');
        if (!unitId || !Number.isFinite(Number(control)))
            continue;
        const merged = button(device(unitId), control);
        merged.seen = true;
        merged.streamable = true;
    }

    return [...devices.values()]
        .map(d => ({...d, buttons: [...d.buttons.values()].sort((a, b) => a.control - b.control)}))
        .filter(d => d.buttons.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name) || a.unitId.localeCompare(b.unitId));
}

// What to remember from a live scan for next time the device is disconnected.
export function cacheFromProbe(probe, previous = []) {
    const kept = new Map((Array.isArray(previous) ? previous : []).map(d => [String(d.unitId), d]));
    for (const found of probe.live ?? []) {
        if (!found.online || !found.unitId)
            continue;
        kept.set(String(found.unitId), {
            unitId: String(found.unitId),
            serial: found.serial ?? null,
            name: found.name,
            buttons: (found.buttons ?? []).map(b => ({control: Number(b.control), name: b.name})),
        });
    }
    return [...kept.values()];
}

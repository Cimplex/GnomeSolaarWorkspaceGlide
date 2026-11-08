// Runs Solaar on behalf of the preferences window: find the Solaar that is
// actually running, ask it which buttons can stream, and switch a button to
// Movement Stream. Only the preferences window uses this; the shell never
// starts processes.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SOLAAR_BUS_NAME} from './movementStream.js';
import {parseCommandLine, parseProbeOutput, parseShebang} from './solaarDiscovery.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const PROBE_TIMEOUT_SECONDS = 25;
const CONFIG_TIMEOUT_SECONDS = 25;

function readFirstLine(path) {
    try {
        const [, contents] = GLib.file_get_contents(path);
        return new TextDecoder().decode(contents.slice(0, 512)).split('\n')[0];
    } catch (_error) {
        return null;
    }
}

function fromScript(script, running = false, pid = null) {
    const shebang = parseShebang(readFirstLine(script));
    if (!shebang)
        return null;
    return {...shebang, script, running, pid};
}

async function runningSolaar(connection) {
    let pid;
    try {
        const reply = await connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetConnectionUnixProcessID', new GLib.Variant('(s)', [SOLAAR_BUS_NAME]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 2000, null);
        [pid] = reply.deepUnpack();
    } catch (_error) {
        return null; // Solaar is not running
    }
    try {
        const [, raw] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        const argv = new TextDecoder().decode(raw).split('\0').filter(arg => arg.length > 0);
        const parsed = parseCommandLine(argv);
        if (!parsed)
            return {running: true, pid, interpreter: null, options: [], script: null};
        if (!parsed.interpreter)
            return fromScript(parsed.script, true, pid) ?? {...parsed, running: true, pid};
        // A relative script path is relative to Solaar's working directory.
        const script = GLib.path_is_absolute(parsed.script)
            ? parsed.script
            : GLib.build_filenamev([GLib.file_read_link(`/proc/${pid}/cwd`), parsed.script]);
        return {...parsed, script, running: true, pid};
    } catch (_error) {
        return {running: true, pid, interpreter: null, options: [], script: null};
    }
}

// Prefer the Solaar that is running, because that is the one sending signals.
// Otherwise the one a user install (pip install --user) puts first, then PATH.
export async function locateSolaar(connection = Gio.DBus.session) {
    const running = await runningSolaar(connection);
    if (running?.script)
        return running;
    const candidates = [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'solaar']),
        GLib.find_program_in_path('solaar'),
    ];
    for (const path of candidates) {
        if (path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) {
            const found = fromScript(path);
            if (found)
                return {...found, running: Boolean(running), pid: running?.pid ?? null};
        }
    }
    return running; // running but unreadable, or null when Solaar is not installed
}

async function run(argv, timeoutSeconds) {
    const cancellable = new Gio.Cancellable();
    const process = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        cancellable.cancel();
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout, stderr] = await process.communicate_utf8_async(null, cancellable);
        return {ok: process.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''};
    } catch (error) {
        if (cancellable.is_cancelled())
            throw new Error(`Solaar did not finish within ${timeoutSeconds} seconds`);
        throw error;
    } finally {
        if (!cancellable.is_cancelled())
            GLib.source_remove(timer);
    }
}

function pythonCommand(solaar, ...args) {
    if (!solaar?.interpreter || !solaar.script)
        throw new Error('Cannot tell how Solaar was started');
    return [solaar.interpreter, ...solaar.options, ...args];
}

function lastLine(text) {
    return text.trim().split('\n').filter(Boolean).at(-1) ?? '';
}

export async function probeSolaar(solaar, probePath, {live = true} = {}) {
    const argv = pythonCommand(solaar, probePath, solaar.script, ...live ? ['--live'] : []);
    const {stdout, stderr} = await run(argv, PROBE_TIMEOUT_SECONDS);
    try {
        return parseProbeOutput(stdout);
    } catch (error) {
        throw new Error(lastLine(stderr) || error.message);
    }
}

// Same as: solaar config <serial> divert-keys <control> <choice>
// `solaar config` also passes the change on to the running Solaar, which saves it.
export async function setMovementStream(solaar, device, control, choice) {
    const target = device.serial || device.name;
    const argv = pythonCommand(solaar, solaar.script, 'config', target, 'divert-keys', String(control), String(choice));
    const {ok, stdout, stderr} = await run(argv, CONFIG_TIMEOUT_SECONDS);
    if (!ok)
        throw new Error(lastLine(stderr).replace(/^solaar: error: /, '') || 'Solaar could not change the setting');
    return lastLine(stdout);
}

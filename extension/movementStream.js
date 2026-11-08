import Gio from 'gi://Gio';

// Signals Solaar sends while a button set to "Movement Stream" is held.
// See docs/capabilities.md in Solaar for the description of each signal.
export const SOLAAR_BUS_NAME = 'io.github.pwr_solaar.solaar';
export const STREAM_PATH = '/io/github/pwr_solaar/solaar';
export const STREAM_INTERFACE = 'io.github.pwr_solaar.solaar.MovementStream';

const SIGNATURES = {Started: '(sq)', Moved: '(sdd)', Ended: '(sb)'};

// Calls onStarted(unitId, control), onMoved(unitId, dx, dy), onEnded(unitId, cancelled)
// and onSolaar(present) when Solaar appears on or leaves the session bus.
export class MovementStream {
    constructor({onStarted = () => {}, onMoved = () => {}, onEnded = () => {}, onSolaar = () => {},
        connection = Gio.DBus.session} = {}) {
        this._connection = connection;
        this._handlers = {Started: onStarted, Moved: onMoved, Ended: onEnded};
        this._onSolaar = onSolaar;
        this.solaarPresent = false;
        // Subscribing by well-known name: the bus only delivers signals from
        // whichever process currently owns it, so another program cannot fake them.
        this._subscription = connection.signal_subscribe(SOLAAR_BUS_NAME, STREAM_INTERFACE, null,
            STREAM_PATH, null, Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, signal, parameters) => this._dispatch(signal, parameters));
        this._watch = Gio.bus_watch_name_on_connection(connection, SOLAAR_BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._presence(true),
            () => this._presence(false));
    }

    _dispatch(signal, parameters) {
        const handler = this._handlers[signal];
        if (!handler || parameters?.get_type_string() !== SIGNATURES[signal])
            return;
        try {
            handler(...parameters.deepUnpack());
        } catch (error) {
            console.error(`[SolaarWorkspaceGlide] ${signal}: ${error.stack ?? error}`);
        }
    }

    _presence(present) {
        if (this.solaarPresent === present)
            return;
        this.solaarPresent = present;
        try {
            this._onSolaar(present);
        } catch (error) {
            console.error(`[SolaarWorkspaceGlide] Solaar presence: ${error.stack ?? error}`);
        }
    }

    destroy() {
        if (this._subscription) {
            this._connection.signal_unsubscribe(this._subscription);
            this._subscription = 0;
        }
        if (this._watch) {
            Gio.bus_unwatch_name(this._watch);
            this._watch = 0;
        }
        this._handlers = {};
        this._onSolaar = () => {};
    }
}

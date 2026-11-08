import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Lets the preferences window start a left-button drag test in the shell.
export const BUS_PATH = '/org/gnome/Shell/Extensions/SolaarWorkspaceGlide';
export const BUS_INTERFACE = 'org.gnome.Shell.Extensions.SolaarWorkspaceGlide';
const BUS_XML = `<node><interface name="${BUS_INTERFACE}">
  <method name="StartTest"><arg name="kind" type="s" direction="in"/><arg type="b" direction="out"/></method>
</interface></node>`;

export class TestService {
    constructor(startTest) {
        this._startTest = startTest;
        this._object = Gio.DBusExportedObject.wrapJSObject(BUS_XML, this);
        this._object.export(Gio.DBus.session, BUS_PATH);
    }

    StartTestAsync([kind], invocation) {
        let accepted = false;
        try {
            accepted = ['horizontal', 'overview'].includes(kind) && Boolean(this._startTest(kind));
        } catch (error) {
            console.error(`[SolaarWorkspaceGlide] test: ${error.stack ?? error}`);
        }
        invocation.return_value(new GLib.Variant('(b)', [accepted]));
    }

    destroy() {
        this._object.unexport();
        this._object = null;
        this._startTest = null;
    }
}

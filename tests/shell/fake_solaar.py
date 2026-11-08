"""Pretend to be Solaar with Movement Stream: own the bus name and emit signals."""
import os, sys, time
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)
reply = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                      GLib.Variant("(su)", ("io.github.pwr_solaar.solaar", 4)), GLib.VariantType("(u)"), 0, -1, None)
PATH, IFACE = "/io/github/pwr_solaar/solaar", "io.github.pwr_solaar.solaar.MovementStream"

def emit(name, sig, args):
    bus.emit_signal(None, PATH, IFACE, name, GLib.Variant(sig, args))
    bus.flush_sync(None)

def pump(seconds):
    ctx = GLib.MainContext.default(); end = time.time() + seconds
    while time.time() < end:
        ctx.iteration(False); time.sleep(0.004)

unit, control = sys.argv[1], int(sys.argv[2])
steps = [tuple(map(float, s.split(","))) for s in sys.argv[3].split(";")] if sys.argv[3] else []
ending = sys.argv[4]  # release | cancel | none
emit("Started", "(sq)", (unit, control))
interval = float(os.environ.get("FAKE_INTERVAL", "0.008"))  # seconds between movement reports
pause = float(os.environ.get("FAKE_PAUSE", "0.2"))  # seconds still before letting go
for dx, dy in steps:
    emit("Moved", "(sdd)", (unit, dx, dy)); pump(interval)
pump(pause)
if ending != "none":
    emit("Ended", "(sb)", (unit, ending == "cancel"))
pump(0.3)
if len(sys.argv) > 5 and sys.argv[5] == "hold":
    pump(float(sys.argv[6]))

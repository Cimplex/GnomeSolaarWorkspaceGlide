"""Ask the installed Solaar which buttons can stream movement.

Run by the preferences window with the same Python interpreter as Solaar:

    python3 solaarProbe.py /path/to/solaar [--live]

Prints a marker line followed by one line of JSON. Without --live it only
reads Solaar's saved configuration; with --live it also opens the connected
devices, the way `solaar show` does, and asks Solaar's own Key/Button
Diversion setting which choices each button has. A button whose choices
include Movement Stream (value 5) can stream; one offering Mouse Gestures
(value 2) has raw XY and could stream with a Solaar that has Movement Stream.

It never changes a device or Solaar's configuration file.
"""

import json
import os
import sys

MARKER = "@@solaar-workspace-glide@@"
MOVEMENT_STREAM = 5
MOUSE_GESTURES = 2
SLIDING_DPI = 3


def use_solaar_from(script):
    """Find Solaar's library the way bin/solaar does when run from a source tree."""
    if not script:
        return
    prefix = os.path.normpath(os.path.join(os.path.dirname(os.path.realpath(script)), ".."))
    for location in (os.path.join(prefix, "lib"), os.path.join(prefix, "share", "solaar", "lib")):
        if os.path.exists(os.path.join(location, "solaar", "__init__.py")):
            sys.path.insert(0, location)
            return


def control_name(cid):
    try:
        from logitech_receiver import special_keys

        return str(special_keys.CONTROL[cid])
    except Exception:
        return f"Control 0x{cid:04X}"


def saved_devices():
    """Devices from Solaar's config.yaml, including ones that are not connected."""
    import yaml

    config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.path.join(config_home, "solaar", "config.yaml")
    try:
        with open(path) as config_file:
            loaded = yaml.safe_load(config_file) or []
    except FileNotFoundError:
        return []
    devices = []
    for entry in loaded[1:] if isinstance(loaded, list) else []:
        if not isinstance(entry, dict):
            continue
        unit_id = entry.get("_unitId") or entry.get("_serial")
        divert = entry.get("divert-keys")
        if not unit_id or not isinstance(divert, dict):
            continue
        buttons = []
        for cid, mode in sorted(divert.items()):
            try:
                cid, mode = int(cid), int(mode)
            except (TypeError, ValueError):
                continue
            buttons.append({"control": cid, "name": control_name(cid), "mode": mode})
        serial = entry.get("_serial")
        devices.append(
            {
                "unitId": str(unit_id),
                "serial": str(serial) if serial else None,
                "name": str(entry.get("_NAME") or unit_id),
                "buttons": buttons,
            }
        )
    return devices


def live_devices(errors):
    from logitech_receiver import settings_templates

    try:
        from solaar.cli import _receivers_and_devices
    except ImportError as e:
        errors.append(f"this Solaar cannot list devices for the probe: {e}")
        return []

    devices = []
    opened = []
    try:
        for found in _receivers_and_devices():
            opened.append(found)
            for dev in [found] if found.isDevice else list(found):
                try:
                    devices.append(describe(dev, settings_templates))
                except Exception as e:
                    errors.append(f"{getattr(dev, 'name', 'device')}: {e}")
    except SystemExit as e:  # Solaar's device listing exits on open errors
        errors.append(str(e.code))
    finally:
        try:
            from logitech_receiver.device import Device

            for dev in list(getattr(Device, "instances", [])):
                dev.close()
        except Exception:
            pass
        for found in opened:
            try:
                found.close()
            except Exception:
                pass
    return devices


def describe(dev, settings_templates):
    online = bool(dev.ping())
    serial = dev.serial or None  # `solaar config` finds a device by serial number
    info = {"unitId": str(dev.unitId or serial or ""), "serial": serial, "name": str(dev.name), "online": online, "buttons": []}
    if not online:
        return info
    info["unitId"] = str(dev.id)  # the unit ID that Movement Stream signals carry
    setting = settings_templates.check_feature_setting(dev, "divert-keys")
    if setting is None:
        return info
    for key, choices in setting.choices.items():
        values = [int(c) for c in choices]
        if MOVEMENT_STREAM not in values and MOUSE_GESTURES not in values:
            continue  # no raw XY: this button cannot stream
        button = {"control": int(key), "name": str(key), "streamable": MOVEMENT_STREAM in values}
        if button["streamable"]:
            # select_choice in `solaar config` takes a 1-based choice index in any language
            button["streamChoice"] = values.index(MOVEMENT_STREAM) + 1
        info["buttons"].append(button)
    return info


def main(argv):
    script = argv[1] if len(argv) > 1 else None
    live = "--live" in argv[2:]
    result = {"version": None, "patched": False, "saved": [], "live": None, "errors": []}
    use_solaar_from(script)
    try:
        import solaar

        result["version"] = str(solaar.__version__)
        from logitech_receiver import settings_templates

        result["patched"] = hasattr(settings_templates, "MovementStreamXY")
    except Exception as e:
        result["errors"].append(f"cannot load Solaar: {e}")
    else:
        try:
            result["saved"] = saved_devices()
        except Exception as e:
            result["errors"].append(f"cannot read Solaar's configuration: {e}")
        if live:
            result["live"] = live_devices(result["errors"])
    sys.stdout.write("\n" + MARKER + "\n" + json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv)

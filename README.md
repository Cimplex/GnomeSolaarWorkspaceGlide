# Solaar Workspace Glide

Hold a button on your Logitech mouse and move it to glide between GNOME workspaces, or up into the overview. The view follows your hand while the button is held, the same way it follows your fingers on a touchpad, and settles when you let go.

<!-- Demo recording goes here: docs/demo.gif -->

It works alongside [Solaar](https://github.com/pwr-Solaar/Solaar), so Solaar keeps managing your mouse. Solaar reads the button and its movement, and this extension moves GNOME.

> [!IMPORTANT]
> **You need a Solaar with Movement Stream.** Movement Stream is a new Key/Button Diversion choice that sends a button's movement to other programs over D-Bus. It has been proposed to Solaar but is not part of a Solaar release yet. Until it is, install Solaar from [my fork](https://github.com/Cimplex/Solaar/tree/movement-stream-live) as shown below. Once Solaar includes it, your distribution's Solaar will work and you can skip step 1.

## What you need

- GNOME Shell 50 (tested on 50.6 under Wayland).
- A Logitech mouse that Solaar supports, with a button that Solaar can divert with movement ("raw XY"). For example, the thumb button on the MX Master 3 and 3S, or the haptic sense panel on the MX Master 4. The preferences window lists the buttons your mouse has.
- It works the same over a Logi Bolt or Unifying receiver and over Bluetooth, because Solaar does the talking to the mouse.

## Setup

### 1. Install Solaar with Movement Stream

Keep your distribution's Solaar package installed: it supplies Solaar's dependencies and the udev rule that lets Solaar talk to the mouse without root. Then install the fork for your user. It takes precedence over the system copy.

```bash
git clone --branch movement-stream-live https://github.com/Cimplex/Solaar.git
cd Solaar
pip install --user --no-deps .
```

Check that your session will start the new one. This should print a path in your home folder, such as `/home/you/.local/bin/solaar`:

```bash
which solaar
```

If it prints `/usr/bin/solaar` instead, `~/.local/bin` is not on your `PATH`. Make Solaar's autostart entry point at the new copy:

```bash
mkdir -p ~/.config/autostart
sed "s|^Exec=solaar|Exec=$HOME/.local/bin/solaar|" /etc/xdg/autostart/solaar.desktop > ~/.config/autostart/solaar.desktop
```

Now restart Solaar. Quit it from its window or tray menu (or run `pkill -f bin/solaar`), then start it again:

```bash
solaar --window=hide &
```

Logging out and back in also works.

> [!NOTE]
> If your distribution has no Solaar package, follow [Solaar's installation guide](https://pwr-solaar.github.io/Solaar/installation) to install its dependencies and udev rule, then run the `pip` step above.

### 2. Install the extension

```bash
git clone https://github.com/Cimplex/GnomeSolaarWorkspaceGlide.git
cd GnomeSolaarWorkspaceGlide
./install.sh
```

Run it as your normal user, without `sudo`. Log out and back in so GNOME Shell finds the extension, then turn it on:

```bash
gnome-extensions enable solaar-workspace-glide@cimplex
```

### 3. Pick a button

Open the preferences, either from the Extensions app or with:

```bash
gnome-extensions prefs solaar-workspace-glide@cimplex
```

The **Buttons** page asks Solaar which buttons on your connected devices can stream movement:

- **Solaar** and **Movement Stream** should both have a check mark. A warning on Movement Stream means the running Solaar is not the fork: go back to step 1.
- Under your mouse, press **Use Movement Stream** next to the button you want. On the MX Master 4 the haptic panel is called **Haptic**; on the MX Master 3 and 3S the thumb button is called **Mouse Gesture Button**.
- Hold that button and move the mouse. The **Live check** row shows the movement arriving.

You can also set it in Solaar itself: open the mouse, find **Key/Button Diversion**, and choose **Movement Stream** for the button. Or from a terminal:

```bash
solaar config "MX Master 4" divert-keys 416 "Movement Stream"
```

(`416` is the Haptic control; use `195` for the Mouse Gesture Button.)

A button can do only one thing at a time, so it no longer runs Solaar's Mouse Gestures rules or its normal action while set to Movement Stream.

### 4. Glide

- **Hold and move left or right:** slide between workspaces.
- **Hold and move up:** open the overview. **Move down** from the overview to close it.
- **Let go:** settle on the nearest workspace or view.
- **Escape** (or another click) while gliding: cancel and go back to where you started.

Each hold picks its direction once it has moved a little (the dead zone), so a sideways glide never turns into the overview halfway through.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Glide with every streaming button | On | Turn off to choose buttons, for example if another button streams to a different program |
| Sensitivity | 3× | How far the view moves for a given mouse movement |
| Acceleration | 1 (Medium) | Larger movements travel progressively further; 0 turns it off |
| Dead zone | 8 | Movement, in counts at 1000 DPI, before a hold picks sideways or up/down |
| Switch point | 50% | How far through the slide you must be when you let go to switch; less settles back |
| Workspace direction | Standard | Standard: the view follows the mouse. Natural: it moves the other way |
| Pointer release delay | 350 ms | Keeps the pointer still briefly after letting go so it does not jump; 0 turns it off |
| Show gesture progress | Off | On-screen progress badge and detailed logs (Diagnostics page) |

Movement is reported at 1000 DPI whatever your mouse's DPI setting, so gliding feels the same if you change DPI.

### Experimental: flick to switch

With **Flick to switch** on (Gestures page, Experimental), a quick movement switches even if it went less than the switch point. It counts as a flick when all of these are true:

- it reached the **flick speed** (150 mm/s by default),
- it never turned back,
- after its fastest moment it kept at least the **keep speed** share of that speed (50% by default) until you let go. Slowing down a lot, or pausing before letting go, settles normally.

A flick moves one workspace (or opens or closes the overview) in the direction you moved. To tune it, turn on **Show gesture progress** under Diagnostics; each release then logs the measured speeds:

```
[SolaarWorkspaceGlide] flick no; peak=212 mm/s; release=64 mm/s; backtrack=0.0 counts
```

## Troubleshooting

**Nothing happens when I hold the button.** Open the preferences and hold the button: if the **Live check** row does not change, Solaar is not sending Movement Stream for that button. Check that the running Solaar is the fork (step 1) and that the button is set to Movement Stream. If the Live check works but GNOME does not move, look at the log:

```bash
journalctl --user -b -f -o cat | grep -E 'SolaarWorkspaceGlide|JS ERROR'
```

**Sideways glides do nothing in the overview.** Workspace gliding works from the desktop. In the overview, move down first to close it.

**It says workspaces must be horizontal.** The workspace glide follows GNOME's standard left-to-right workspace layout.

**A hold right after the mouse wakes up does nothing.** Solaar re-applies its settings when the mouse reconnects, which ends any hold in progress. Give it a second and try again.

**The Diagnostics tests work but the button does not.** The tests check GNOME's side with an ordinary left-button drag, without Solaar. If they work, the problem is between the mouse and Solaar.

## How it works

While a button set to Movement Stream is held, Solaar emits these signals on the session bus, from its bus name `io.github.pwr_solaar.solaar`, object `/io/github/pwr_solaar/solaar`, interface `io.github.pwr_solaar.solaar.MovementStream`:

| Signal | Arguments | Sent |
| --- | --- | --- |
| `Started` | `s` unit ID, `q` control ID | when the button is pressed |
| `Moved` | `s` unit ID, `d` dx, `d` dy | for each movement report, in counts at 1000 DPI |
| `Ended` | `s` unit ID, `b` cancelled | when the button is released; `cancelled` is true if the hold ended some other way (the mouse disconnected, the setting changed, Solaar re-applied settings) |

The extension subscribes to those signals, locks each hold to sideways or up/down, and drives GNOME's own workspace and overview swipe animations, the same ones the touchpad uses, once per frame. Any program can listen to the same signals; try `gdbus monitor --session --dest io.github.pwr_solaar.solaar`.

The preferences window finds the Solaar that owns the bus name and asks it which buttons can stream, using Solaar's own Key/Button Diversion setting, so the list matches what Solaar offers. **Use Movement Stream** runs `solaar config`, which hands the change to the running Solaar. The shell side never starts any programs.

## Development

```bash
./check.sh          # syntax, schema and unit tests (needs node for the tests)
./check.sh --shell  # also runs the extension in a headless GNOME Shell with a fake Solaar
./pack.sh           # builds dist/solaar-workspace-glide@cimplex.shell-extension.zip
```

The headless test starts a private GNOME Shell on its own D-Bus with its own settings, so it does not touch your session. A fake Solaar in `tests/shell/fake_solaar.py` sends Movement Stream signals, and the test checks the resulting workspace and overview state.

## Uninstall

```bash
./uninstall.sh
```

To go back to your distribution's Solaar, first set any Movement Stream buttons back to another choice in Solaar's Key/Button Diversion. Then run `pip uninstall solaar`, delete `~/.config/autostart/solaar.desktop` if you created it, and restart Solaar.

## Credits

The GNOME gesture code started in [Workspace Glide](https://github.com/Cimplex/WorkspaceGlide), an earlier version that read the mouse directly and so could not run at the same time as Solaar. Thanks to the Solaar developers for the library and device support this builds on.

## License

GPL-2.0-or-later, the same as Solaar. See [LICENSE](LICENSE).
